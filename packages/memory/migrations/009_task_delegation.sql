-- ============================================================
-- MIGRATION: F3 delegation — assignee_id (v1.11.0)
-- ============================================================
-- Lets a task be assigned to a teammate (assignee_id), distinct from owner_id
-- (the creator). Adds task_assign(), an 'assigned' event, and an optional
-- assignee filter on task_list/task_next.
--
-- Safe to run repeatedly. Run AFTER 04/05/06/07/08. Does NOT touch Temporal `tasks`.
-- ============================================================

-- ------------------------------------------------------------
-- 1. column + event enum
-- ------------------------------------------------------------
ALTER TABLE task_items ADD COLUMN IF NOT EXISTS assignee_id TEXT;
CREATE INDEX IF NOT EXISTS idx_task_items_assignee ON task_items(assignee_id);

DO $$
BEGIN
  ALTER TABLE task_events DROP CONSTRAINT IF EXISTS task_events_event_check;
  ALTER TABLE task_events ADD CONSTRAINT task_events_event_check
    CHECK (event IN ('created','status','estimate','cycle','reopened','removed','assigned'));
END $$;

-- ------------------------------------------------------------
-- 2. task_assign: set assignee + emit an 'assigned' event (owner/admin guarded)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION task_assign(
  p_task_id  UUID,
  p_assignee TEXT
) RETURNS task_items LANGUAGE plpgsql AS $$
DECLARE
  caller TEXT := request_owner_id();
  row    task_items;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'unauthenticated'; END IF;
  UPDATE task_items SET assignee_id = (CASE WHEN p_assignee = '' THEN NULL ELSE p_assignee END)
   WHERE id = p_task_id
     AND (owner_id = caller OR (SELECT role FROM keys WHERE hash = request_key_hash()) = 'admin')
   RETURNING * INTO row;
  IF row.id IS NULL THEN RAISE EXCEPTION 'task not found or not owned'; END IF;
  INSERT INTO task_events(task_id, cycle_id, owner_id, event, to_points, meta)
  VALUES (row.id, row.cycle_id, caller, 'assigned', row.estimate,
          jsonb_build_object('assignee', p_assignee));
  RETURN row;
END;
$$;

-- ------------------------------------------------------------
-- 3. task_list (REDEFINED): + trailing p_assignee filter. Old 7-arg dropped.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS task_list(TEXT,TEXT,TEXT,TEXT,BOOLEAN,INTEGER,TEXT);
CREATE OR REPLACE FUNCTION task_list(
  p_workstream   TEXT DEFAULT NULL,
  p_status       TEXT DEFAULT NULL,
  p_priority     TEXT DEFAULT NULL,
  p_project      TEXT DEFAULT NULL,
  p_include_done BOOLEAN DEFAULT false,
  n              INTEGER DEFAULT 100,
  p_sort         TEXT DEFAULT 'order',
  p_assignee     TEXT DEFAULT NULL
) RETURNS TABLE (
  id UUID, title TEXT, status TEXT, priority TEXT, due_date DATE,
  workstream TEXT, order_key TEXT, estimate NUMERIC, cycle_id UUID,
  blocked BOOLEAN, due_state TEXT, assignee_id TEXT
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
         t.assignee_id
  FROM task_items t
  WHERE (t.scope IN ('team','global') OR t.owner_id = caller)
    AND (p_workstream IS NULL OR t.workstream = p_workstream)
    AND (p_status     IS NULL OR t.status     = p_status)
    AND (p_priority   IS NULL OR t.priority   = p_priority)
    AND (p_project    IS NULL OR t.project    = p_project)
    AND (p_assignee   IS NULL OR t.assignee_id = p_assignee)
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
-- 4. task_next (REDEFINED): + trailing p_assignee filter. Old 2-arg dropped.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS task_next(TEXT,INTEGER);
CREATE OR REPLACE FUNCTION task_next(
  p_workstream TEXT DEFAULT NULL,
  n            INTEGER DEFAULT 5,
  p_assignee   TEXT DEFAULT NULL
) RETURNS TABLE (
  id UUID, title TEXT, priority TEXT, due_date DATE,
  workstream TEXT, estimate NUMERIC, due_state TEXT, assignee_id TEXT
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
         END AS due_state,
         t.assignee_id
  FROM task_items t
  WHERE (t.scope IN ('team','global') OR t.owner_id = caller)
    AND t.status IN ('todo','doing')
    AND (p_workstream IS NULL OR t.workstream = p_workstream)
    AND (p_assignee   IS NULL OR t.assignee_id = p_assignee)
    AND NOT task_is_blocked(t.id)
  ORDER BY t.priority ASC,
           t.due_date ASC NULLS LAST,
           (t.status = 'doing') DESC,
           t.order_key
  LIMIT n;
END;
$$;

-- ------------------------------------------------------------
-- 5. grants
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION task_assign(UUID,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION task_list(TEXT,TEXT,TEXT,TEXT,BOOLEAN,INTEGER,TEXT,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION task_next(TEXT,INTEGER,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION task_assign(UUID,TEXT) TO braintrust_api;
GRANT EXECUTE ON FUNCTION task_list(TEXT,TEXT,TEXT,TEXT,BOOLEAN,INTEGER,TEXT,TEXT) TO braintrust_api;
GRANT EXECUTE ON FUNCTION task_next(TEXT,INTEGER,TEXT) TO braintrust_api;
