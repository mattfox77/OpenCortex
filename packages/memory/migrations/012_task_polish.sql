-- ============================================================
-- MIGRATION: Polish — task_list consolidation, CFD membership hardening,
--            parent auto-complete (v1.14.0)
-- ============================================================
-- P2: re-declares task_list as the SINGLE canonical definition (behavior
--     identical to migration 11 — this is the one place to edit going forward).
-- P3: task_add now records meta.workstream on the 'created' event;
--     cumulative_flow membership prefers that historical value (current fallback).
-- P4: opt-in parent auto-complete (all children terminal -> parent done).
--
-- Safe to run repeatedly. Run AFTER 04..11. Does NOT touch Temporal `tasks`.
-- ============================================================

-- ------------------------------------------------------------
-- 1. auto_complete column (P4) — opt-in, default off
-- ------------------------------------------------------------
ALTER TABLE task_items ADD COLUMN IF NOT EXISTS auto_complete BOOLEAN NOT NULL DEFAULT false;

-- ------------------------------------------------------------
-- 2. task_add (REDEFINED): record meta.workstream on the 'created' event (P3).
--    Signature unchanged (10-arg) so no overload/grant changes needed.
-- ------------------------------------------------------------
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
  FROM task_items WHERE owner_id = caller AND workstream = p_workstream;
  new_key := COALESCE(last_key, '') || 'n';
  INSERT INTO task_items(owner_id, author, scope, title, body, priority,
                         due_date, workstream, order_key, project, estimate, cycle_id)
  VALUES (caller, p_author, p_scope, p_title, p_body, p_priority,
          p_due, p_workstream, new_key, p_project, p_estimate, p_cycle)
  RETURNING * INTO row;
  INSERT INTO task_events(task_id, cycle_id, owner_id, event, to_status, to_points, meta)
  VALUES (row.id, row.cycle_id, caller, 'created', row.status, row.estimate,
          jsonb_build_object('workstream', p_workstream));   -- P3: historical workstream
  RETURN row;
END;
$$;

-- ------------------------------------------------------------
-- 3. task_set_status (REDEFINED): emit event as before, PLUS P4 parent
--    auto-complete — if the changed task is a child whose parent opted in and
--    all siblings are now terminal, complete the parent (one level up).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION task_set_status(
  p_id     UUID,
  p_status TEXT
) RETURNS task_items LANGUAGE plpgsql AS $$
DECLARE
  caller   TEXT := request_owner_id();
  old_st   TEXT;
  ev       TEXT;
  row      task_items;
  par      UUID;
  par_auto BOOLEAN;
  open_sibs INT;
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

  INSERT INTO task_events(task_id, cycle_id, owner_id, event, from_status, to_status, to_points)
  VALUES (row.id, row.cycle_id, caller, ev, old_st, p_status, row.estimate);

  -- P4: parent auto-complete (only when the child just became terminal)
  IF row.parent_id IS NOT NULL AND p_status IN ('done','cancelled') THEN
    SELECT auto_complete INTO par_auto FROM task_items WHERE id = row.parent_id;
    IF par_auto THEN
      SELECT count(*) INTO open_sibs FROM task_items
      WHERE parent_id = row.parent_id AND status NOT IN ('done','cancelled');
      IF open_sibs = 0 THEN
        PERFORM task_set_status(row.parent_id, 'done');
      END IF;
    END IF;
  END IF;

  RETURN row;
END;
$$;

-- ------------------------------------------------------------
-- 4. cumulative_flow (REDEFINED): membership prefers the 'created' event's
--    meta.workstream (historical), falling back to current workstream (P3).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION cumulative_flow(
  p_workstream TEXT,
  p_days       INTEGER DEFAULT 30
) RETURNS TABLE (
  day DATE, created_cum BIGINT, done_cum BIGINT, wip BIGINT
) LANGUAGE plpgsql AS $$
DECLARE
  caller TEXT := request_owner_id();
  d0     DATE := current_date - GREATEST(1, p_days);
BEGIN
  RETURN QUERY
  WITH days AS (
    SELECT generate_series(d0, current_date, interval '1 day')::date AS day
  ),
  members AS (
    SELECT t.id, t.created_at::date AS created_day
    FROM task_items t
    WHERE (t.scope IN ('team','global') OR t.owner_id = caller)
      AND COALESCE(
            (SELECT te.meta->>'workstream' FROM task_events te
              WHERE te.task_id = t.id AND te.event = 'created'
              ORDER BY te.ts ASC, te.seq ASC LIMIT 1),
            t.workstream
          ) = p_workstream
  ),
  per_day AS (
    SELECT g.day, m.id,
           (m.created_day <= g.day) AS created_by,
           ((SELECT te.to_status FROM task_events te
              WHERE te.task_id = m.id AND te.to_status IS NOT NULL
                AND te.ts::date <= g.day
              ORDER BY te.ts DESC, te.seq DESC LIMIT 1) IN ('done','cancelled')) AS done_by
    FROM days g CROSS JOIN members m
  )
  SELECT g.day,
         count(pd.id) FILTER (WHERE pd.created_by)::bigint,
         count(pd.id) FILTER (WHERE pd.created_by AND pd.done_by)::bigint,
         count(pd.id) FILTER (WHERE pd.created_by AND NOT pd.done_by)::bigint
  FROM days g LEFT JOIN per_day pd ON pd.day = g.day
  GROUP BY g.day
  ORDER BY g.day;
END;
$$;

-- ------------------------------------------------------------
-- 5. task_list — CANONICAL DEFINITION (P2). Edit task_list HERE going forward.
--    Behavior identical to migration 11 (10-arg). Drop the prior sig first.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS task_list(TEXT,TEXT,TEXT,TEXT,BOOLEAN,INTEGER,TEXT,TEXT,TEXT,UUID);
CREATE OR REPLACE FUNCTION task_list(
  p_workstream   TEXT DEFAULT NULL,
  p_status       TEXT DEFAULT NULL,
  p_priority     TEXT DEFAULT NULL,
  p_project      TEXT DEFAULT NULL,
  p_include_done BOOLEAN DEFAULT false,
  n              INTEGER DEFAULT 100,
  p_sort         TEXT DEFAULT 'order',
  p_assignee     TEXT DEFAULT NULL,
  p_tag          TEXT DEFAULT NULL,
  p_parent       UUID DEFAULT NULL
) RETURNS TABLE (
  id UUID, title TEXT, status TEXT, priority TEXT, due_date DATE,
  workstream TEXT, order_key TEXT, estimate NUMERIC, cycle_id UUID,
  blocked BOOLEAN, due_state TEXT, assignee_id TEXT, tags TEXT[],
  parent_id UUID, subtask_count BIGINT, done_subtasks BIGINT
) LANGUAGE plpgsql AS $$
DECLARE caller TEXT := request_owner_id();
BEGIN
  RETURN QUERY
  SELECT t.id, t.title, t.status, t.priority, t.due_date,
         t.workstream, t.order_key, t.estimate, t.cycle_id,
         task_is_blocked(t.id) AS blocked,
         CASE
           WHEN t.due_date IS NULL THEN NULL
           WHEN t.status IN ('done','cancelled') THEN NULL
           WHEN t.due_date < current_date THEN 'overdue'
           WHEN t.due_date <= current_date + 2 THEN 'due_soon'
           ELSE 'ok'
         END AS due_state,
         t.assignee_id, t.tags, t.parent_id,
         (SELECT count(*) FROM task_items c WHERE c.parent_id = t.id)::bigint AS subtask_count,
         (SELECT count(*) FROM task_items c WHERE c.parent_id = t.id
            AND c.status IN ('done','cancelled'))::bigint AS done_subtasks
  FROM task_items t
  WHERE (t.scope IN ('team','global') OR t.owner_id = caller)
    AND (p_workstream IS NULL OR t.workstream = p_workstream)
    AND (p_status     IS NULL OR t.status     = p_status)
    AND (p_priority   IS NULL OR t.priority   = p_priority)
    AND (p_project    IS NULL OR t.project    = p_project)
    AND (p_assignee   IS NULL OR t.assignee_id = p_assignee)
    AND (p_tag        IS NULL OR p_tag = ANY(t.tags))
    AND (CASE WHEN p_parent IS NOT NULL THEN t.parent_id = p_parent
              ELSE t.parent_id IS NULL END)
    AND (p_include_done OR t.status NOT IN ('done','cancelled'))
  ORDER BY
    t.workstream,
    CASE WHEN p_sort = 'priority' THEN t.priority END ASC NULLS LAST,
    CASE WHEN p_sort = 'due' THEN t.due_date END ASC NULLS LAST,
    t.order_key,
    t.priority
  LIMIT n;
END;
$$;

-- ------------------------------------------------------------
-- 6. grants (re-assert; signatures unchanged for the redefined fns)
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION task_add(TEXT,TEXT,TEXT,DATE,TEXT,TEXT,TEXT,TEXT,NUMERIC,UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION task_set_status(UUID,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION cumulative_flow(TEXT,INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION task_list(TEXT,TEXT,TEXT,TEXT,BOOLEAN,INTEGER,TEXT,TEXT,TEXT,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION task_add(TEXT,TEXT,TEXT,DATE,TEXT,TEXT,TEXT,TEXT,NUMERIC,UUID) TO opencortex_memory_api;
GRANT EXECUTE ON FUNCTION task_set_status(UUID,TEXT) TO opencortex_memory_api;
GRANT EXECUTE ON FUNCTION cumulative_flow(TEXT,INTEGER) TO opencortex_memory_api;
GRANT EXECUTE ON FUNCTION task_list(TEXT,TEXT,TEXT,TEXT,BOOLEAN,INTEGER,TEXT,TEXT,TEXT,UUID) TO opencortex_memory_api;
