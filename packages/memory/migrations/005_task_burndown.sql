-- ============================================================
-- MIGRATION: Burndown layer for brain task (events + cycles + points)
-- ============================================================
-- Reframes the Task List as a burndown: remaining work over time.
-- Adds: task_cycles (time-box), task_events (append-only history),
--       task_items.cycle_id + .estimate, and burndown()/velocity() RPCs.
--
-- Safe to run repeatedly. Run AFTER 04-migration-task-items.sql.
-- Does NOT touch the Temporal-style `tasks` table.
--
-- ORDERING REQUIREMENT (important): always apply migrations in numeric order
-- (04 then 05). 05 redefines task_add with a wider signature and drops the
-- 04 8-arg version to avoid an ambiguous PostgREST overload. Re-running 04 by
-- itself AFTER 05 would resurrect the 8-arg overload — if you must replay 04,
-- replay 05 immediately after.
--
-- Design: BraintTrust2_Context/docs/TASK-LIST-DESIGN.md (§Burndown)
-- ============================================================

-- ============================================================
-- 1. TASK_CYCLES: a time-boxed unit to burn down within (B)
-- ============================================================

CREATE TABLE IF NOT EXISTS task_cycles (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at    TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at    TIMESTAMPTZ DEFAULT now() NOT NULL,
  owner_id      TEXT NOT NULL,
  scope         TEXT NOT NULL DEFAULT 'personal'
                  CHECK (scope IN ('personal','team','global')),
  name          TEXT NOT NULL,
  workstream    TEXT,
  starts_on     DATE NOT NULL DEFAULT current_date,
  target_date   DATE NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('planned','active','closed')),
  committed_points NUMERIC DEFAULT 0,   -- scope baseline at start
  meta          JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_task_cycles_owner  ON task_cycles(owner_id);
CREATE INDEX IF NOT EXISTS idx_task_cycles_status ON task_cycles(status);
CREATE INDEX IF NOT EXISTS idx_task_cycles_scope  ON task_cycles(scope);

DROP TRIGGER IF EXISTS task_cycles_ts ON task_cycles;
CREATE TRIGGER task_cycles_ts BEFORE UPDATE ON task_cycles
  FOR EACH ROW EXECUTE FUNCTION update_ts();

-- ============================================================
-- 2. TASK_ITEMS: add cycle_id (B) + estimate points (C)
-- ============================================================

ALTER TABLE task_items ADD COLUMN IF NOT EXISTS cycle_id UUID
  REFERENCES task_cycles(id) ON DELETE SET NULL;
ALTER TABLE task_items ADD COLUMN IF NOT EXISTS estimate NUMERIC NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_task_items_cycle ON task_items(cycle_id);

-- ============================================================
-- 3. TASK_EVENTS: append-only transition history (A)
-- ============================================================

CREATE TABLE IF NOT EXISTS task_events (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  seq           BIGINT GENERATED ALWAYS AS IDENTITY,  -- monotonic total order
  ts            TIMESTAMPTZ DEFAULT now() NOT NULL,
  task_id       UUID NOT NULL REFERENCES task_items(id) ON DELETE CASCADE,
  cycle_id      UUID REFERENCES task_cycles(id) ON DELETE SET NULL,
  owner_id      TEXT NOT NULL,
  event         TEXT NOT NULL
                  CHECK (event IN ('created','status','estimate',
                                   'cycle','reopened','removed')),
  from_status   TEXT,
  to_status     TEXT,
  from_points   NUMERIC,
  to_points     NUMERIC,
  meta          JSONB DEFAULT '{}'
);

-- seq: bulletproof tiebreaker for events that share now()'s transaction
-- timestamp (e.g. the 'removed'+'cycle' pair from a single cycle_assign).
-- Replays order by (ts DESC, seq DESC) for a deterministic total order.
-- Idempotent add for deployments that already created task_events without it.
-- On backfill, existing rows receive seq values in physical insertion order,
-- which preserves their relative arrival order (good enough — ts stays primary).
ALTER TABLE task_events ADD COLUMN IF NOT EXISTS seq BIGINT GENERATED ALWAYS AS IDENTITY;

CREATE INDEX IF NOT EXISTS idx_task_events_task   ON task_events(task_id, ts);
CREATE INDEX IF NOT EXISTS idx_task_events_replay ON task_events(task_id, ts DESC, seq DESC);
CREATE INDEX IF NOT EXISTS idx_task_events_cycle  ON task_events(cycle_id, ts);
CREATE INDEX IF NOT EXISTS idx_task_events_owner  ON task_events(owner_id);
CREATE INDEX IF NOT EXISTS idx_task_events_ts     ON task_events(ts);

-- ============================================================
-- 4. RLS + GRANTS
-- ============================================================

ALTER TABLE task_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_events ENABLE ROW LEVEL SECURITY;

-- task_cycles
DROP POLICY IF EXISTS task_cycles_select_policy ON task_cycles;
CREATE POLICY task_cycles_select_policy ON task_cycles
  FOR SELECT USING (
    scope = 'global' OR scope = 'team'
    OR (scope = 'personal' AND owner_id = request_owner_id())
    OR (SELECT role FROM keys WHERE hash = request_key_hash()) = 'admin'
  );
DROP POLICY IF EXISTS task_cycles_insert_policy ON task_cycles;
CREATE POLICY task_cycles_insert_policy ON task_cycles
  FOR INSERT WITH CHECK (owner_id = request_owner_id());
DROP POLICY IF EXISTS task_cycles_update_policy ON task_cycles;
CREATE POLICY task_cycles_update_policy ON task_cycles
  FOR UPDATE USING (owner_id = request_owner_id())
             WITH CHECK (owner_id = request_owner_id());
DROP POLICY IF EXISTS task_cycles_delete_policy ON task_cycles;
CREATE POLICY task_cycles_delete_policy ON task_cycles
  FOR DELETE USING (owner_id = request_owner_id());

-- task_events: append-only — SELECT + INSERT only, no UPDATE/DELETE policy
DROP POLICY IF EXISTS task_events_select_policy ON task_events;
CREATE POLICY task_events_select_policy ON task_events
  FOR SELECT USING (
    owner_id = request_owner_id()
    OR (SELECT role FROM keys WHERE hash = request_key_hash()) = 'admin'
  );
DROP POLICY IF EXISTS task_events_insert_policy ON task_events;
CREATE POLICY task_events_insert_policy ON task_events
  FOR INSERT WITH CHECK (owner_id = request_owner_id());

REVOKE ALL ON TABLE task_cycles FROM PUBLIC;
REVOKE ALL ON TABLE task_events FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON task_cycles TO opencortex_memory_api;
GRANT SELECT, INSERT                 ON task_events TO opencortex_memory_api;  -- append-only

-- ============================================================
-- 5. FUNCTIONS
-- ============================================================

-- task_add (REPLACE the 04 version): now accepts estimate + cycle and
-- emits a 'created' event atomically.
-- Drop the old 8-arg signature first — CREATE OR REPLACE only matches an
-- identical signature, so without this the 04 version would linger as a
-- separate overload and make the PostgREST RPC ambiguous.
DROP FUNCTION IF EXISTS task_add(TEXT,TEXT,TEXT,DATE,TEXT,TEXT,TEXT,TEXT);
CREATE OR REPLACE FUNCTION task_add(
  p_title      TEXT,
  p_workstream TEXT DEFAULT 'inbox',
  p_priority   TEXT DEFAULT 'p2',
  p_due        DATE DEFAULT NULL,
  p_scope      TEXT DEFAULT 'personal',
  p_project    TEXT DEFAULT NULL,
  p_body       TEXT DEFAULT NULL,
  p_author     TEXT DEFAULT 'user',
  p_estimate   NUMERIC DEFAULT 1,
  p_cycle      UUID DEFAULT NULL
) RETURNS task_items LANGUAGE plpgsql AS $$
DECLARE
  caller   TEXT := request_owner_id();
  last_key TEXT;
  new_key  TEXT;
  row      task_items;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'unauthenticated'; END IF;

  SELECT max(order_key) INTO last_key
  FROM task_items
  WHERE owner_id = caller AND workstream = p_workstream;
  new_key := COALESCE(last_key, '') || 'n';

  INSERT INTO task_items(owner_id, author, scope, title, body, priority,
                         due_date, workstream, order_key, project,
                         estimate, cycle_id)
  VALUES (caller, p_author, p_scope, p_title, p_body, p_priority,
          p_due, p_workstream, new_key, p_project, p_estimate, p_cycle)
  RETURNING * INTO row;

  INSERT INTO task_events(task_id, cycle_id, owner_id, event, to_status, to_points)
  VALUES (row.id, row.cycle_id, caller, 'created', row.status, row.estimate);

  RETURN row;
END;
$$;

-- task_set_status: mutate status AND record an event in ONE transaction.
-- This is the only correct path for status changes (burndown integrity).
CREATE OR REPLACE FUNCTION task_set_status(
  p_id     UUID,
  p_status TEXT
) RETURNS task_items LANGUAGE plpgsql AS $$
DECLARE
  caller   TEXT := request_owner_id();
  old_st   TEXT;
  ev       TEXT;
  row      task_items;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'unauthenticated'; END IF;

  SELECT status INTO old_st FROM task_items WHERE id = p_id AND owner_id = caller;
  IF old_st IS NULL THEN RAISE EXCEPTION 'task not found or not owned'; END IF;

  ev := CASE WHEN old_st IN ('done','cancelled') AND p_status NOT IN ('done','cancelled')
             THEN 'reopened' ELSE 'status' END;

  UPDATE task_items
     SET status = p_status,
         completed_at = CASE WHEN p_status IN ('done','cancelled') THEN now() ELSE NULL END
   WHERE id = p_id AND owner_id = caller
   RETURNING * INTO row;

  INSERT INTO task_events(task_id, cycle_id, owner_id, event,
                          from_status, to_status, to_points)
  VALUES (row.id, row.cycle_id, caller, ev, old_st, p_status, row.estimate);

  RETURN row;
END;
$$;

-- task_set_estimate: mutate points AND record an event atomically.
CREATE OR REPLACE FUNCTION task_set_estimate(
  p_id       UUID,
  p_estimate NUMERIC
) RETURNS task_items LANGUAGE plpgsql AS $$
DECLARE
  caller TEXT := request_owner_id();
  old_pt NUMERIC;
  row    task_items;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'unauthenticated'; END IF;

  SELECT estimate INTO old_pt FROM task_items WHERE id = p_id AND owner_id = caller;
  IF old_pt IS NULL THEN RAISE EXCEPTION 'task not found or not owned'; END IF;

  UPDATE task_items SET estimate = p_estimate
   WHERE id = p_id AND owner_id = caller RETURNING * INTO row;

  INSERT INTO task_events(task_id, cycle_id, owner_id, event, from_points, to_points)
  VALUES (row.id, row.cycle_id, caller, 'estimate', old_pt, p_estimate);

  RETURN row;
END;
$$;

-- cycle_add: create a burndown cycle (time-box).
CREATE OR REPLACE FUNCTION cycle_add(
  p_name      TEXT,
  p_target    DATE,
  p_starts    DATE DEFAULT NULL,
  p_workstream TEXT DEFAULT NULL,
  p_scope     TEXT DEFAULT 'personal'
) RETURNS task_cycles LANGUAGE plpgsql AS $$
DECLARE
  caller TEXT := request_owner_id();
  row    task_cycles;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'unauthenticated'; END IF;
  INSERT INTO task_cycles(owner_id, scope, name, workstream, starts_on, target_date)
  VALUES (caller, p_scope, p_name, p_workstream,
          COALESCE(p_starts, current_date), p_target)
  RETURNING * INTO row;
  RETURN row;
END;
$$;

-- cycle_assign: move a task into a cycle. Emits a 'removed' event against the
-- OLD cycle (when it changes and was non-null) and a 'cycle' event for the new
-- one — so a cycle's burndown can detect tasks that leave it. One transaction.
CREATE OR REPLACE FUNCTION cycle_assign(
  p_task_id  UUID,
  p_cycle_id UUID
) RETURNS task_items LANGUAGE plpgsql AS $$
DECLARE
  caller   TEXT := request_owner_id();
  old_cyc  UUID;
  row      task_items;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'unauthenticated'; END IF;

  SELECT cycle_id INTO old_cyc FROM task_items WHERE id = p_task_id AND owner_id = caller;
  IF NOT FOUND THEN RAISE EXCEPTION 'task not found or not owned'; END IF;

  -- record departure from the previous cycle (if any and actually changing).
  -- NOTE: this 'removed' event and the 'cycle' event below share now()'s
  -- transaction timestamp; replay queries break the tie with the monotonic
  -- task_events.seq (ORDER BY ts DESC, seq DESC), so the later-inserted 'cycle'
  -- event wins and A→B→A re-entry resolves correctly.
  IF old_cyc IS NOT NULL AND old_cyc IS DISTINCT FROM p_cycle_id THEN
    INSERT INTO task_events(task_id, cycle_id, owner_id, event, to_points)
    SELECT p_task_id, old_cyc, caller, 'removed', ti.estimate
    FROM task_items ti WHERE ti.id = p_task_id;
  END IF;

  UPDATE task_items SET cycle_id = p_cycle_id
   WHERE id = p_task_id AND owner_id = caller RETURNING * INTO row;

  -- record entry into the new cycle (if any)
  IF p_cycle_id IS NOT NULL AND p_cycle_id IS DISTINCT FROM old_cyc THEN
    INSERT INTO task_events(task_id, cycle_id, owner_id, event, to_points)
    VALUES (row.id, p_cycle_id, caller, 'cycle', row.estimate);
  END IF;

  RETURN row;
END;
$$;

-- burndown: replay task_events for a cycle into daily buckets.
--   remaining_points = committed points still open at end of each day.
--   ideal_points = straight line from committed scope (day 0) to 0 (target).
--   FULLY event-sourced (v1.7.2): membership, points, AND exits are all replayed
--   from task_events, so the chart is reproducible regardless of later edits.
--     * membership as-of day D = the task's latest cycle-affecting event
--       (created-into-cycle / cycle / removed) with ts<=D resolves to THIS cycle.
--       Handles enter→leave→re-enter correctly (latest event wins).
--     * points as-of day D = latest to_points from a created/estimate event with ts<=D.
--     * status as-of day D = latest to_status with ts<=D.
--   base committed scope = sum of each member's points as of the cycle target.
CREATE OR REPLACE FUNCTION burndown(p_cycle_id UUID)
RETURNS TABLE (
  day DATE, remaining_count BIGINT, remaining_points NUMERIC, ideal_points NUMERIC
) LANGUAGE plpgsql AS $$
DECLARE
  d0     DATE;   -- cycle start
  dtgt   DATE;   -- cycle target (drives the IDEAL line, never moves)
  daxis  DATE;   -- right edge of the plotted day series (extends to today if overdue)
  base   NUMERIC;
  span   INT;
BEGIN
  SELECT starts_on, target_date INTO d0, dtgt FROM task_cycles WHERE id = p_cycle_id;
  IF d0 IS NULL THEN RAISE EXCEPTION 'cycle not found'; END IF;

  span  := GREATEST(1, (dtgt - d0));
  daxis := GREATEST(dtgt, current_date);

  -- committed scope (the ideal line's starting height): for every task that is a
  -- member of this cycle as of the TARGET date, its points as of the target date.
  -- Fully event-sourced so later estimate edits don't rewrite the baseline.
  SELECT COALESCE(sum(pts), 0) INTO base FROM (
    SELECT c.task_id,
           (SELECT te.to_points FROM task_events te
             WHERE te.task_id = c.task_id AND te.to_points IS NOT NULL
               AND te.ts::date <= dtgt
             ORDER BY te.ts DESC, te.seq DESC LIMIT 1) AS pts
    FROM (SELECT DISTINCT task_id FROM task_events WHERE cycle_id = p_cycle_id) c
    WHERE (SELECT (te.event IN ('created','cycle') AND te.cycle_id = p_cycle_id)
             FROM task_events te
            WHERE te.task_id = c.task_id
              AND te.event IN ('created','cycle','removed')
              AND te.ts::date <= dtgt
            ORDER BY te.ts DESC, te.seq DESC LIMIT 1) IS TRUE
  ) committed_members;

  RETURN QUERY
  WITH days AS (
    SELECT generate_series(d0, daxis, interval '1 day')::date AS day
  ),
  -- every task that ever had ANY event referencing this cycle (candidate set)
  candidates AS (
    SELECT DISTINCT te.task_id
    FROM task_events te
    WHERE te.cycle_id = p_cycle_id
  ),
  -- per (day, candidate): is the task a member of THIS cycle at end of day, its
  -- points, and its status — all from the latest qualifying event with ts<=day.
  per_day AS (
    SELECT g.day,
           c.task_id,
           -- membership: latest cycle-affecting event for this task as of the day.
           -- It belongs to this cycle iff that event is an entry (created/cycle)
           -- whose cycle_id = p_cycle_id (a 'removed' or entry-elsewhere ends it).
           (SELECT (te.event IN ('created','cycle') AND te.cycle_id = p_cycle_id)
              FROM task_events te
             WHERE te.task_id = c.task_id
                AND te.event IN ('created','cycle','removed')
                AND te.ts::date <= g.day
              ORDER BY te.ts DESC, te.seq DESC LIMIT 1) AS is_member,
           (SELECT te.to_points
              FROM task_events te
             WHERE te.task_id = c.task_id
               AND te.to_points IS NOT NULL
               AND te.ts::date <= g.day
             ORDER BY te.ts DESC, te.seq DESC LIMIT 1) AS points_eod,
           (SELECT te.to_status
              FROM task_events te
             WHERE te.task_id = c.task_id
               AND te.to_status IS NOT NULL
               AND te.ts::date <= g.day
             ORDER BY te.ts DESC, te.seq DESC LIMIT 1) AS status_eod
    FROM days g
    CROSS JOIN candidates c
  ),
  -- collapse to only rows where the task is a member and still open that day
  open_rows AS (
    SELECT per_day.day AS d, per_day.task_id, COALESCE(per_day.points_eod, 0) AS pts
    FROM per_day
    WHERE per_day.is_member IS TRUE
      AND (per_day.status_eod IS NULL OR per_day.status_eod NOT IN ('done','cancelled'))
  )
  SELECT g.day,
         count(o.task_id)::bigint                          AS remaining_count,
         COALESCE(sum(o.pts), 0)                            AS remaining_points,
         GREATEST(0, round(base * (1.0 - (g.day - d0)::numeric / span), 2)) AS ideal_points
  FROM days g
  LEFT JOIN open_rows o ON o.d = g.day
  GROUP BY g.day, d0, span, base
  ORDER BY g.day;
END;
$$;

-- velocity: committed vs completed points per recent cycle for the caller.
-- Event-sourced (v1.7.2): "committed" = points of tasks that were members of the
-- cycle as of its target_date; "completed" = those whose status as of target_date
-- was 'done'. Reproducible — independent of later cycle_id/status/estimate edits.
CREATE OR REPLACE FUNCTION velocity(
  p_workstream TEXT DEFAULT NULL,
  n            INTEGER DEFAULT 6
) RETURNS TABLE (
  cycle_id UUID, name TEXT, target_date DATE,
  committed NUMERIC, completed NUMERIC
) LANGUAGE plpgsql AS $$
DECLARE caller TEXT := request_owner_id();
BEGIN
  RETURN QUERY
  WITH cyc AS (
    SELECT c.id, c.name, c.target_date
    FROM task_cycles c
    WHERE (c.scope IN ('team','global') OR c.owner_id = caller)
      AND (p_workstream IS NULL OR c.workstream = p_workstream)
    ORDER BY c.target_date DESC
    LIMIT n
  ),
  mem AS (  -- tasks that were members of each cycle as of its target_date, with eod points/status
    SELECT cyc.id AS cyc_id, cyc.name, cyc.target_date, t.task_id,
           (SELECT te.to_points FROM task_events te
             WHERE te.task_id = t.task_id AND te.to_points IS NOT NULL
               AND te.ts::date <= cyc.target_date
             ORDER BY te.ts DESC, te.seq DESC LIMIT 1) AS pts,
           (SELECT te.to_status FROM task_events te
             WHERE te.task_id = t.task_id AND te.to_status IS NOT NULL
               AND te.ts::date <= cyc.target_date
             ORDER BY te.ts DESC, te.seq DESC LIMIT 1) AS st
    FROM cyc
    JOIN LATERAL (SELECT DISTINCT te.task_id FROM task_events te
                   WHERE te.cycle_id = cyc.id) t ON true
    WHERE (SELECT (te.event IN ('created','cycle') AND te.cycle_id = cyc.id)
             FROM task_events te
            WHERE te.task_id = t.task_id
              AND te.event IN ('created','cycle','removed')
              AND te.ts::date <= cyc.target_date
            ORDER BY te.ts DESC, te.seq DESC LIMIT 1) IS TRUE
  )
  SELECT m.cyc_id, m.name, m.target_date,
         COALESCE(sum(m.pts),0) AS committed,
         COALESCE(sum(m.pts) FILTER (WHERE m.st = 'done'),0) AS completed
  FROM mem m
  GROUP BY m.cyc_id, m.name, m.target_date
  ORDER BY m.target_date DESC;
END;
$$;

-- ============================================================
-- 6. FUNCTION GRANTS
-- ============================================================

REVOKE ALL ON FUNCTION task_add(TEXT,TEXT,TEXT,DATE,TEXT,TEXT,TEXT,TEXT,NUMERIC,UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION task_set_status(UUID,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION task_set_estimate(UUID,NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION cycle_add(TEXT,DATE,DATE,TEXT,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION cycle_assign(UUID,UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION burndown(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION velocity(TEXT,INTEGER) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION task_add(TEXT,TEXT,TEXT,DATE,TEXT,TEXT,TEXT,TEXT,NUMERIC,UUID) TO opencortex_memory_api;
GRANT EXECUTE ON FUNCTION task_set_status(UUID,TEXT) TO opencortex_memory_api;
GRANT EXECUTE ON FUNCTION task_set_estimate(UUID,NUMERIC) TO opencortex_memory_api;
GRANT EXECUTE ON FUNCTION cycle_add(TEXT,DATE,DATE,TEXT,TEXT) TO opencortex_memory_api;
GRANT EXECUTE ON FUNCTION cycle_assign(UUID,UUID) TO opencortex_memory_api;
GRANT EXECUTE ON FUNCTION burndown(UUID) TO opencortex_memory_api;
GRANT EXECUTE ON FUNCTION velocity(TEXT,INTEGER) TO opencortex_memory_api;
