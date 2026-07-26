-- ============================================================
-- MIGRATION: F4 tag filter + G3 cumulative-flow (v1.12.0)
-- ============================================================
-- F4: optional single-tag filter on task_list.
-- G3: cumulative_flow() — arrivals vs completions vs WIP per day, replayed
--     from task_events. The honest throughput metric for open-ended
--     (non-cycle) workstreams where a burndown never converges.
--
-- Safe to run repeatedly. Run AFTER 04..09. Does NOT touch Temporal `tasks`.
-- ============================================================

-- ------------------------------------------------------------
-- 1. task_list (REDEFINED): + trailing p_tag. Old 8-arg dropped.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS task_list(TEXT,TEXT,TEXT,TEXT,BOOLEAN,INTEGER,TEXT,TEXT);
CREATE OR REPLACE FUNCTION task_list(
  p_workstream   TEXT DEFAULT NULL,
  p_status       TEXT DEFAULT NULL,
  p_priority     TEXT DEFAULT NULL,
  p_project      TEXT DEFAULT NULL,
  p_include_done BOOLEAN DEFAULT false,
  n              INTEGER DEFAULT 100,
  p_sort         TEXT DEFAULT 'order',
  p_assignee     TEXT DEFAULT NULL,
  p_tag          TEXT DEFAULT NULL
) RETURNS TABLE (
  id UUID, title TEXT, status TEXT, priority TEXT, due_date DATE,
  workstream TEXT, order_key TEXT, estimate NUMERIC, cycle_id UUID,
  blocked BOOLEAN, due_state TEXT, assignee_id TEXT, tags TEXT[]
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
         t.assignee_id, t.tags
  FROM task_items t
  WHERE (t.scope IN ('team','global') OR t.owner_id = caller)
    AND (p_workstream IS NULL OR t.workstream = p_workstream)
    AND (p_status     IS NULL OR t.status     = p_status)
    AND (p_priority   IS NULL OR t.priority   = p_priority)
    AND (p_project    IS NULL OR t.project    = p_project)
    AND (p_assignee   IS NULL OR t.assignee_id = p_assignee)
    AND (p_tag        IS NULL OR p_tag = ANY(t.tags))
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
-- 2. cumulative_flow: per-day cumulative arrivals (created), completions
--    (done/cancelled), and WIP (open) for a workstream, replayed from events.
--    Membership = tasks currently in the workstream that have a 'created' event.
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
    WHERE t.workstream = p_workstream
      AND (t.scope IN ('team','global') OR t.owner_id = caller)
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
         count(pd.id) FILTER (WHERE pd.created_by)::bigint AS created_cum,
         count(pd.id) FILTER (WHERE pd.created_by AND pd.done_by)::bigint AS done_cum,
         count(pd.id) FILTER (WHERE pd.created_by AND NOT pd.done_by)::bigint AS wip
  FROM days g LEFT JOIN per_day pd ON pd.day = g.day
  GROUP BY g.day
  ORDER BY g.day;
END;
$$;

-- ------------------------------------------------------------
-- 3. grants
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION task_list(TEXT,TEXT,TEXT,TEXT,BOOLEAN,INTEGER,TEXT,TEXT,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION cumulative_flow(TEXT,INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION task_list(TEXT,TEXT,TEXT,TEXT,BOOLEAN,INTEGER,TEXT,TEXT,TEXT) TO braintrust_api;
GRANT EXECUTE ON FUNCTION cumulative_flow(TEXT,INTEGER) TO braintrust_api;
