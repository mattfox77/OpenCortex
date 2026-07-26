-- ============================================================
-- MIGRATION: F6 sub-tasks — parent/child decomposition (v1.13.0)
-- ============================================================
-- A task may have a parent_id (self-FK). A sub-task is an ordinary task_item
-- with parent_id set — it inherits all behavior (events, ordering, assignee,
-- tags) for free. Parent progress (done/total children) is DERIVED, not stored.
--
-- Safe to run repeatedly. Run AFTER 04..10. Does NOT touch Temporal `tasks`.
-- ============================================================

-- ------------------------------------------------------------
-- 1. parent_id self-FK (children cascade-delete with their parent)
-- ------------------------------------------------------------
ALTER TABLE task_items ADD COLUMN IF NOT EXISTS parent_id UUID
  REFERENCES task_items(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_task_items_parent ON task_items(parent_id);

-- ------------------------------------------------------------
-- 2. task_subtasks: children of a parent + their status (RLS-scoped).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION task_subtasks(p_parent UUID)
RETURNS TABLE (
  id UUID, title TEXT, status TEXT, priority TEXT, assignee_id TEXT, order_key TEXT
) LANGUAGE plpgsql AS $$
DECLARE caller TEXT := request_owner_id();
BEGIN
  RETURN QUERY
  SELECT t.id, t.title, t.status, t.priority, t.assignee_id, t.order_key
  FROM task_items t
  WHERE t.parent_id = p_parent
    AND (t.scope IN ('team','global') OR t.owner_id = caller)
  ORDER BY t.order_key, t.priority;
END;
$$;

-- ------------------------------------------------------------
-- 3. task_list (REDEFINED): + parent_id, subtask_count, done_subtasks columns,
--    + p_parent filter. DEFAULT shows top-level only (parent_id IS NULL) so the
--    list isn't flooded by children; pass p_parent to list a parent's children.
--    Old 9-arg signature dropped.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS task_list(TEXT,TEXT,TEXT,TEXT,BOOLEAN,INTEGER,TEXT,TEXT,TEXT);
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
              ELSE t.parent_id IS NULL END)   -- top-level by default; children when p_parent set
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
-- 4. grants
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION task_subtasks(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION task_list(TEXT,TEXT,TEXT,TEXT,BOOLEAN,INTEGER,TEXT,TEXT,TEXT,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION task_subtasks(UUID) TO braintrust_api;
GRANT EXECUTE ON FUNCTION task_list(TEXT,TEXT,TEXT,TEXT,BOOLEAN,INTEGER,TEXT,TEXT,TEXT,UUID) TO braintrust_api;
