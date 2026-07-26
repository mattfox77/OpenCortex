-- ============================================================
-- MIGRATION: O1 semantic task search (v1.9.0)
-- ============================================================
-- Makes tasks findable via `brain search` by mirroring each task into an
-- ordinary `entries` row (kind='task', embedded), reusing the existing
-- search() pgvector+FTS+RLS machinery. No new search path.
--
-- Safe to run repeatedly. Run AFTER 04/05/06. Does NOT touch Temporal `tasks`.
-- ============================================================

-- ------------------------------------------------------------
-- 1. entries.kind: allow 'task' (drop + recreate the CHECK constraint)
-- ------------------------------------------------------------
DO $$
BEGIN
  ALTER TABLE entries DROP CONSTRAINT IF EXISTS entries_kind_check;
  ALTER TABLE entries ADD CONSTRAINT entries_kind_check
    CHECK (kind IN ('thought','finding','decision','document','chunk','task'));
END $$;

-- ------------------------------------------------------------
-- 2. task_items.search_entry_id — the mirror entry used for search.
--    Distinct from entry_id (the 'graduated' canonical finding).
-- ------------------------------------------------------------
ALTER TABLE task_items ADD COLUMN IF NOT EXISTS search_entry_id UUID
  REFERENCES entries(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_task_items_search_entry ON task_items(search_entry_id);

-- ------------------------------------------------------------
-- 3. task_set_search_entry: link a task to its mirror entry (RLS-guarded).
--    Called by the CLI right after it creates/refreshes the embedded mirror.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION task_set_search_entry(
  p_task_id  UUID,
  p_entry_id UUID
) RETURNS task_items LANGUAGE plpgsql AS $$
DECLARE
  caller TEXT := request_owner_id();
  row    task_items;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'unauthenticated'; END IF;
  UPDATE task_items SET search_entry_id = p_entry_id
   WHERE id = p_task_id AND owner_id = caller RETURNING * INTO row;
  IF row.id IS NULL THEN RAISE EXCEPTION 'task not found or not owned'; END IF;
  RETURN row;
END;
$$;

REVOKE ALL ON FUNCTION task_set_search_entry(UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION task_set_search_entry(UUID,UUID) TO braintrust_api;
