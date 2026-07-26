-- ============================================================
-- MIGRATION: user-facing Task List (task_items + task_entries)
-- ============================================================
-- OpenCortex task item schema carried forward from BrainTrust capability code.
-- All DDL guarded with IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY.
-- Run AFTER 01-schema.sql (depends on: update_ts(), keys, entries,
-- request_owner_id(), request_key_hash(), opencortex_memory_api role).
--
-- This migration does NOT touch the Temporal-style `tasks` table
-- (01-schema.sql:182) — that is a workflow-execution queue. User to-dos
-- live in the new `task_items` table introduced here.
--
-- Design: BraintTrust2_Context/docs/TASK-LIST-DESIGN.md
-- ============================================================

-- ============================================================
-- 1. TASK_ITEMS: user/agent to-dos
-- ============================================================

CREATE TABLE IF NOT EXISTS task_items (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at    TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at    TIMESTAMPTZ DEFAULT now() NOT NULL,

  owner_id      TEXT NOT NULL,
  author        TEXT NOT NULL DEFAULT 'user'
                  CHECK (author IN ('user', 'agent')),
  scope         TEXT NOT NULL DEFAULT 'personal'
                  CHECK (scope IN ('personal', 'team', 'global')),

  title         TEXT NOT NULL,
  body          TEXT,
  status        TEXT NOT NULL DEFAULT 'todo'
                  CHECK (status IN ('todo','doing','blocked','done','cancelled')),
  priority      TEXT NOT NULL DEFAULT 'p2'
                  CHECK (priority IN ('p0','p1','p2','p3')),
  due_date      DATE,

  workstream    TEXT NOT NULL DEFAULT 'inbox',
  order_key     TEXT NOT NULL DEFAULT 'n',

  blocked_by    UUID[] DEFAULT '{}',

  project       TEXT,
  repo          TEXT,
  entry_id      UUID REFERENCES entries(id) ON DELETE SET NULL,
  tags          TEXT[] DEFAULT '{}',
  meta          JSONB DEFAULT '{}',

  completed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_task_items_owner       ON task_items(owner_id);
CREATE INDEX IF NOT EXISTS idx_task_items_workstream  ON task_items(workstream);
CREATE INDEX IF NOT EXISTS idx_task_items_status      ON task_items(status);
CREATE INDEX IF NOT EXISTS idx_task_items_priority    ON task_items(priority);
CREATE INDEX IF NOT EXISTS idx_task_items_due         ON task_items(due_date);
CREATE INDEX IF NOT EXISTS idx_task_items_project     ON task_items(project);
CREATE INDEX IF NOT EXISTS idx_task_items_scope       ON task_items(scope);
CREATE INDEX IF NOT EXISTS idx_task_items_entry       ON task_items(entry_id);
CREATE INDEX IF NOT EXISTS idx_task_items_order
  ON task_items(owner_id, workstream, order_key);

DROP TRIGGER IF EXISTS task_items_ts ON task_items;
CREATE TRIGGER task_items_ts BEFORE UPDATE ON task_items
  FOR EACH ROW EXECUTE FUNCTION update_ts();

-- ============================================================
-- 2. TASK_ENTRIES: junction linking a task to many brain entries
--    (notes, findings, decisions captured over the task's life)
-- ============================================================

CREATE TABLE IF NOT EXISTS task_entries (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at    TIMESTAMPTZ DEFAULT now() NOT NULL,
  task_id       UUID NOT NULL REFERENCES task_items(id) ON DELETE CASCADE,
  entry_id      UUID NOT NULL REFERENCES entries(id)     ON DELETE CASCADE,
  owner_id      TEXT NOT NULL,
  relationship  TEXT NOT NULL DEFAULT 'note'
                  CHECK (relationship IN ('note','finding','decision',
                                          'context','result','graduated')),
  meta          JSONB DEFAULT '{}'
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_task_entries_pair
  ON task_entries(task_id, entry_id);
CREATE INDEX IF NOT EXISTS idx_task_entries_task  ON task_entries(task_id);
CREATE INDEX IF NOT EXISTS idx_task_entries_entry ON task_entries(entry_id);
CREATE INDEX IF NOT EXISTS idx_task_entries_owner ON task_entries(owner_id);

-- ============================================================
-- 3. RLS + GRANTS
-- ============================================================

ALTER TABLE task_items   ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_entries ENABLE ROW LEVEL SECURITY;

-- task_items policies
DROP POLICY IF EXISTS task_items_select_policy ON task_items;
CREATE POLICY task_items_select_policy ON task_items
  FOR SELECT USING (
    scope = 'global'
    OR scope = 'team'
    OR (scope = 'personal' AND owner_id = request_owner_id())
    OR (SELECT role FROM keys WHERE hash = request_key_hash()) = 'admin'
  );

DROP POLICY IF EXISTS task_items_insert_policy ON task_items;
CREATE POLICY task_items_insert_policy ON task_items
  FOR INSERT WITH CHECK (owner_id = request_owner_id());

DROP POLICY IF EXISTS task_items_update_policy ON task_items;
CREATE POLICY task_items_update_policy ON task_items
  FOR UPDATE USING (owner_id = request_owner_id())
             WITH CHECK (owner_id = request_owner_id());

DROP POLICY IF EXISTS task_items_delete_policy ON task_items;
CREATE POLICY task_items_delete_policy ON task_items
  FOR DELETE USING (owner_id = request_owner_id());

-- task_entries policies
DROP POLICY IF EXISTS task_entries_select_policy ON task_entries;
CREATE POLICY task_entries_select_policy ON task_entries
  FOR SELECT USING (
    owner_id = request_owner_id()
    OR (SELECT role FROM keys WHERE hash = request_key_hash()) = 'admin'
  );

DROP POLICY IF EXISTS task_entries_insert_policy ON task_entries;
CREATE POLICY task_entries_insert_policy ON task_entries
  FOR INSERT WITH CHECK (owner_id = request_owner_id());

-- UPDATE policy is REQUIRED for task_link_entry's ON CONFLICT DO UPDATE
-- (re-linking the same task/entry pair to change its relationship).
DROP POLICY IF EXISTS task_entries_update_policy ON task_entries;
CREATE POLICY task_entries_update_policy ON task_entries
  FOR UPDATE USING (owner_id = request_owner_id())
             WITH CHECK (owner_id = request_owner_id());

DROP POLICY IF EXISTS task_entries_delete_policy ON task_entries;
CREATE POLICY task_entries_delete_policy ON task_entries
  FOR DELETE USING (owner_id = request_owner_id());

REVOKE ALL ON TABLE task_items   FROM PUBLIC;
REVOKE ALL ON TABLE task_entries FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON task_items   TO opencortex_memory_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON task_entries TO opencortex_memory_api;

-- ============================================================
-- 4. FUNCTIONS
-- ============================================================

-- lexo_between: smallest string that sorts strictly between lo and hi.
--   lo NULL  → before hi (prepend)        hi NULL → after lo (append)
--   both NULL → 'n'                        Simplified a..z, 1 char/step.
CREATE OR REPLACE FUNCTION lexo_between(lo TEXT, hi TEXT)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE a INT; b INT; m INT;
BEGIN
  IF lo IS NULL AND hi IS NULL THEN RETURN 'n'; END IF;
  IF lo IS NULL THEN
    a := ascii('a') - 1; b := ascii(substr(hi,1,1));
  ELSIF hi IS NULL THEN
    a := ascii(substr(lo,1,1)); b := ascii('z') + 1;
  ELSE
    a := ascii(substr(lo,1,1)); b := ascii(substr(hi,1,1));
  END IF;
  m := (a + b) / 2;
  IF m <= a THEN
    -- no integer gap at this char position; extend the lo key one level deeper
    RETURN COALESCE(lo,'') || 'n';
  END IF;
  RETURN chr(m);
END;
$$;

-- task_add: create a task, auto-assigning an order_key at the end of its
--           workstream for the caller.
CREATE OR REPLACE FUNCTION task_add(
  p_title      TEXT,
  p_workstream TEXT DEFAULT 'inbox',
  p_priority   TEXT DEFAULT 'p2',
  p_due        DATE DEFAULT NULL,
  p_scope      TEXT DEFAULT 'personal',
  p_project    TEXT DEFAULT NULL,
  p_body       TEXT DEFAULT NULL,
  p_author     TEXT DEFAULT 'user'
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
                         due_date, workstream, order_key, project)
  VALUES (caller, p_author, p_scope, p_title, p_body, p_priority,
          p_due, p_workstream, new_key, p_project)
  RETURNING * INTO row;

  RETURN row;
END;
$$;

-- task_reorder: move p_id between p_before (ends up above) and p_after
--               (ends up below). Single-row UPDATE via lexo midpoint key.
CREATE OR REPLACE FUNCTION task_reorder(
  p_id     UUID,
  p_before UUID DEFAULT NULL,
  p_after  UUID DEFAULT NULL
) RETURNS task_items LANGUAGE plpgsql AS $$
DECLARE
  caller TEXT := request_owner_id();
  lo     TEXT;
  hi     TEXT;
  mid    TEXT;
  row    task_items;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'unauthenticated'; END IF;

  SELECT order_key INTO lo FROM task_items WHERE id = p_before AND owner_id = caller;
  SELECT order_key INTO hi FROM task_items WHERE id = p_after  AND owner_id = caller;

  mid := lexo_between(lo, hi);

  UPDATE task_items SET order_key = mid
  WHERE id = p_id AND owner_id = caller
  RETURNING * INTO row;

  IF row.id IS NULL THEN RAISE EXCEPTION 'task not found or not owned'; END IF;
  RETURN row;
END;
$$;

-- task_list: caller-scoped list, ordered by workstream then manual order_key.
CREATE OR REPLACE FUNCTION task_list(
  p_workstream TEXT DEFAULT NULL,
  p_status     TEXT DEFAULT NULL,
  p_priority   TEXT DEFAULT NULL,
  p_project    TEXT DEFAULT NULL,
  p_include_done BOOLEAN DEFAULT false,
  n            INTEGER DEFAULT 100
) RETURNS SETOF task_items LANGUAGE plpgsql AS $$
DECLARE caller TEXT := request_owner_id();
BEGIN
  RETURN QUERY
  SELECT * FROM task_items t
  WHERE (t.scope IN ('team','global') OR t.owner_id = caller)
    AND (p_workstream IS NULL OR t.workstream = p_workstream)
    AND (p_status    IS NULL OR t.status     = p_status)
    AND (p_priority  IS NULL OR t.priority   = p_priority)
    AND (p_project   IS NULL OR t.project    = p_project)
    AND (p_include_done OR t.status NOT IN ('done','cancelled'))
  ORDER BY t.workstream, t.order_key, t.priority
  LIMIT n;
END;
$$;

-- task_link_entry: attach an EXISTING brain entry to a task. Idempotent.
--   rel='graduated' also sets task_items.entry_id (the canonical entry).
CREATE OR REPLACE FUNCTION task_link_entry(
  p_task_id  UUID,
  p_entry_id UUID,
  p_rel      TEXT DEFAULT 'note'
) RETURNS task_entries LANGUAGE plpgsql AS $$
DECLARE
  caller TEXT := request_owner_id();
  row    task_entries;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'unauthenticated'; END IF;

  INSERT INTO task_entries(task_id, entry_id, owner_id, relationship)
  VALUES (p_task_id, p_entry_id, caller, p_rel)
  ON CONFLICT (task_id, entry_id)
    DO UPDATE SET relationship = EXCLUDED.relationship
  RETURNING * INTO row;

  IF p_rel = 'graduated' THEN
    UPDATE task_items SET entry_id = p_entry_id
    WHERE id = p_task_id AND owner_id = caller;
  END IF;

  RETURN row;
END;
$$;

-- task_entries_list: all brain entries linked to a task, newest first.
CREATE OR REPLACE FUNCTION task_entries_list(p_task_id UUID)
RETURNS TABLE (
  entry_id UUID, relationship TEXT, kind TEXT, title TEXT,
  content TEXT, scope TEXT, review TEXT, linked_at TIMESTAMPTZ
) LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT e.id, te.relationship, e.kind, e.title,
         left(e.content, 500), e.scope, e.review, te.created_at
  FROM task_entries te
  JOIN entries e ON e.id = te.entry_id
  WHERE te.task_id = p_task_id
  ORDER BY te.created_at DESC;
END;
$$;

-- ============================================================
-- 5. FUNCTION GRANTS
-- ============================================================

REVOKE ALL ON FUNCTION lexo_between(TEXT,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION task_add(TEXT,TEXT,TEXT,DATE,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION task_reorder(UUID,UUID,UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION task_list(TEXT,TEXT,TEXT,TEXT,BOOLEAN,INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION task_link_entry(UUID,UUID,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION task_entries_list(UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION lexo_between(TEXT,TEXT) TO opencortex_memory_api;
GRANT EXECUTE ON FUNCTION task_add(TEXT,TEXT,TEXT,DATE,TEXT,TEXT,TEXT,TEXT) TO opencortex_memory_api;
GRANT EXECUTE ON FUNCTION task_reorder(UUID,UUID,UUID) TO opencortex_memory_api;
GRANT EXECUTE ON FUNCTION task_list(TEXT,TEXT,TEXT,TEXT,BOOLEAN,INTEGER) TO opencortex_memory_api;
GRANT EXECUTE ON FUNCTION task_link_entry(UUID,UUID,TEXT) TO opencortex_memory_api;
GRANT EXECUTE ON FUNCTION task_entries_list(UUID) TO opencortex_memory_api;
