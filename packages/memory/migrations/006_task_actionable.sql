-- ============================================================
-- MIGRATION: Task actionability, next, sort, rollover (v1.8.0)
-- ============================================================
-- Adds dependency-aware actionability (real blocked_by), `task next`,
-- sortable task_list, workstream-resolved burndown, and cycle rollover.
--
-- Safe to run repeatedly. Run AFTER 04 and 05 (depends on task_items,
-- task_cycles, task_events, cycle_assign, burndown, request_owner_id()).
-- ORDERING: apply 04 -> 05 -> 06 in order. Does NOT touch the Temporal `tasks` table.
--
-- Design: BraintTrust2_Context/docs/TASK-LIST-DESIGN.md
-- ============================================================

-- ============================================================
-- 1. task_is_blocked: a task is blocked iff it is still open AND at least one
--    of its blocked_by dependencies is not yet done/cancelled.
-- ============================================================
CREATE OR REPLACE FUNCTION task_is_blocked(p_task_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $$
DECLARE
  st     TEXT;
  deps   UUID[];
  open_blockers INT;
BEGIN
  SELECT status, blocked_by INTO st, deps FROM task_items WHERE id = p_task_id;
  IF st IS NULL THEN RETURN FALSE; END IF;
  IF st IN ('done','cancelled') THEN RETURN FALSE; END IF;
  IF deps IS NULL OR array_length(deps,1) IS NULL THEN RETURN FALSE; END IF;

  SELECT count(*) INTO open_blockers
  FROM task_items b
  WHERE b.id = ANY(deps)
    AND b.status NOT IN ('done','cancelled');

  RETURN open_blockers > 0;
END;
$$;

-- ============================================================
-- 2. task_depends_on: does p_node (transitively) depend on p_target?
--    Used by `task block` to warn about dependency cycles — adding
--    "target blocked_by node" closes a loop when node already depends on target.
-- ============================================================
CREATE OR REPLACE FUNCTION task_depends_on(p_node UUID, p_target UUID)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $$
DECLARE
  found BOOLEAN;
BEGIN
  -- walk the blocked_by graph from p_node; TRUE if we reach p_target.
  WITH RECURSIVE deps(id) AS (
    SELECT unnest(blocked_by) FROM task_items WHERE id = p_node
    UNION
    SELECT unnest(ti.blocked_by)
    FROM task_items ti JOIN deps d ON ti.id = d.id
  )
  SELECT EXISTS (SELECT 1 FROM deps WHERE id = p_target) INTO found;
  RETURN COALESCE(found, FALSE);
END;
$$;

-- ============================================================
-- 3. task_list (REDEFINED): add p_sort (order|priority|due) + derived
--    `blocked` and `overdue`/`due_soon` markers via a wrapper view shape.
--    Returns task_items plus computed columns. Old 6-arg signature dropped
--    to avoid an ambiguous PostgREST overload.
-- ============================================================
DROP FUNCTION IF EXISTS task_list(TEXT,TEXT,TEXT,TEXT,BOOLEAN,INTEGER);
CREATE OR REPLACE FUNCTION task_list(
  p_workstream   TEXT DEFAULT NULL,
  p_status       TEXT DEFAULT NULL,
  p_priority     TEXT DEFAULT NULL,
  p_project      TEXT DEFAULT NULL,
  p_include_done BOOLEAN DEFAULT false,
  n              INTEGER DEFAULT 100,
  p_sort         TEXT DEFAULT 'order'    -- order | priority | due
) RETURNS TABLE (
  id UUID, title TEXT, status TEXT, priority TEXT, due_date DATE,
  workstream TEXT, order_key TEXT, estimate NUMERIC, cycle_id UUID,
  blocked BOOLEAN, due_state TEXT
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
         END AS due_state
  FROM task_items t
  WHERE (t.scope IN ('team','global') OR t.owner_id = caller)
    AND (p_workstream IS NULL OR t.workstream = p_workstream)
    AND (p_status     IS NULL OR t.status     = p_status)
    AND (p_priority   IS NULL OR t.priority   = p_priority)
    AND (p_project    IS NULL OR t.project    = p_project)
    AND (p_include_done OR t.status NOT IN ('done','cancelled'))
  ORDER BY
    t.workstream,
    CASE WHEN p_sort = 'priority' THEN t.priority END ASC NULLS LAST,
    CASE WHEN p_sort = 'due' THEN t.due_date END ASC NULLS LAST,
    t.order_key,
    t.priority           -- preserve the prior default tiebreak
  LIMIT n;
END;
$$;

-- ============================================================
-- 4. task_next: the actionable queue — open, NOT blocked, ranked by
--    priority then due_date then manual order. Answers "what do I do now".
-- ============================================================
CREATE OR REPLACE FUNCTION task_next(
  p_workstream TEXT DEFAULT NULL,
  n            INTEGER DEFAULT 5
) RETURNS TABLE (
  id UUID, title TEXT, priority TEXT, due_date DATE,
  workstream TEXT, estimate NUMERIC, due_state TEXT
) LANGUAGE plpgsql AS $$
DECLARE caller TEXT := request_owner_id();
BEGIN
  RETURN QUERY
  SELECT t.id, t.title, t.priority, t.due_date, t.workstream, t.estimate,
         CASE
           WHEN t.due_date IS NULL THEN NULL
           WHEN t.due_date < current_date THEN 'overdue'
           WHEN t.due_date <= current_date + 2 THEN 'due_soon'
           ELSE 'ok'
         END AS due_state
  FROM task_items t
  WHERE (t.scope IN ('team','global') OR t.owner_id = caller)
    AND t.status IN ('todo','doing')
    AND (p_workstream IS NULL OR t.workstream = p_workstream)
    AND NOT task_is_blocked(t.id)
  ORDER BY t.priority ASC,                          -- p0 first
           t.due_date ASC NULLS LAST,
           (t.status = 'doing') DESC,               -- in-progress edges ahead
           t.order_key
  LIMIT n;
END;
$$;

-- ============================================================
-- 5. burndown_ws: resolve the most recent active cycle for a workstream,
--    then return its burndown. Lets `task burndown -w stream` skip the UUID.
-- ============================================================
CREATE OR REPLACE FUNCTION burndown_ws(p_workstream TEXT)
RETURNS TABLE (
  day DATE, remaining_count BIGINT, remaining_points NUMERIC, ideal_points NUMERIC
) LANGUAGE plpgsql AS $$
DECLARE
  caller TEXT := request_owner_id();
  cyc    UUID;
BEGIN
  SELECT id INTO cyc FROM task_cycles
  WHERE (scope IN ('team','global') OR owner_id = caller)
    AND workstream = p_workstream
    AND status = 'active'
  ORDER BY target_date DESC LIMIT 1;
  IF cyc IS NULL THEN
    RAISE EXCEPTION 'no active cycle for workstream %', p_workstream;
  END IF;
  RETURN QUERY SELECT * FROM burndown(cyc);
END;
$$;

-- ============================================================
-- 6. cycle_close: close a cycle and optionally roll unfinished member tasks
--    forward into a new cycle (emitting removed/cycle events via cycle_assign).
-- ============================================================
CREATE OR REPLACE FUNCTION cycle_close(
  p_cycle_id    UUID,
  p_rollover_to UUID DEFAULT NULL
) RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
  caller   TEXT := request_owner_id();
  moved    INT := 0;
  r        RECORD;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'unauthenticated'; END IF;

  UPDATE task_cycles SET status = 'closed'
   WHERE id = p_cycle_id AND owner_id = caller;
  IF NOT FOUND THEN RAISE EXCEPTION 'cycle not found or not owned'; END IF;

  IF p_rollover_to IS NOT NULL THEN
    -- the caller must own the destination cycle (cycle_assign only checks task
    -- ownership, so guard here to prevent dumping tasks into another owner's cycle).
    IF NOT EXISTS (SELECT 1 FROM task_cycles
                   WHERE id = p_rollover_to AND owner_id = caller) THEN
      RAISE EXCEPTION 'rollover cycle not found or not owned';
    END IF;
    FOR r IN
      SELECT id FROM task_items
      WHERE cycle_id = p_cycle_id AND owner_id = caller
        AND status NOT IN ('done','cancelled')
    LOOP
      PERFORM cycle_assign(r.id, p_rollover_to);
      moved := moved + 1;
    END LOOP;
  END IF;

  RETURN moved;
END;
$$;

-- ============================================================
-- 7. GRANTS
-- ============================================================
REVOKE ALL ON FUNCTION task_is_blocked(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION task_depends_on(UUID,UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION task_list(TEXT,TEXT,TEXT,TEXT,BOOLEAN,INTEGER,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION task_next(TEXT,INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION burndown_ws(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION cycle_close(UUID,UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION task_is_blocked(UUID) TO braintrust_api;
GRANT EXECUTE ON FUNCTION task_depends_on(UUID,UUID) TO braintrust_api;
GRANT EXECUTE ON FUNCTION task_list(TEXT,TEXT,TEXT,TEXT,BOOLEAN,INTEGER,TEXT) TO braintrust_api;
GRANT EXECUTE ON FUNCTION task_next(TEXT,INTEGER) TO braintrust_api;
GRANT EXECUTE ON FUNCTION burndown_ws(TEXT) TO braintrust_api;
GRANT EXECUTE ON FUNCTION cycle_close(UUID,UUID) TO braintrust_api;
