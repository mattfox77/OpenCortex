-- 023_issue_cards.sql
-- Issue cards: where people and agents talk about one piece of work (Matt 2026-11-02).
--
-- A card stands for a target, a tracker step, a package of work, a decision or a commitment,
-- named by its key (T-GEN, S4-SUCC, SUCC26, D-20261102-01, C-20261102-01). Cards form a tree
-- (package -> step -> target) through parent_key, and point at the task_items row they mirror
-- when there is one. Comments are their own records, shaped for a conversation: who wrote it
-- (a person, an agent role, an issue thread, or the system), how it came in, a reply-to, edits
-- and removals kept, full-text search. Followers are the roles told of new comments.
--
-- Built for the issue cards' needs rather than squeezed into entries/task_entries (Matt:
-- "what OpenCortex already has may not be right; we have to build to our needs").
-- Row security follows the task tables: team-visible, writes by the owning key.

CREATE TABLE IF NOT EXISTS cards (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project     text NOT NULL,
  key         text NOT NULL CHECK (length(key) BETWEEN 1 AND 80 AND key !~ '[[:space:]/\\"''`<>]'),
  kind        text NOT NULL CHECK (kind IN ('target','step','package','decision','commitment','other')),
  parent_key  text,
  task_id     uuid REFERENCES task_items(id) ON DELETE SET NULL,
  title       text,
  scope       text NOT NULL DEFAULT 'team' CHECK (scope IN ('personal','team','global')),
  owner_id    text NOT NULL DEFAULT request_owner_id(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project, key)
);

CREATE TABLE IF NOT EXISTS card_followers (
  card_id   uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  follower  text NOT NULL CHECK (length(follower) BETWEEN 1 AND 120),
  added_by  text,
  owner_id  text NOT NULL DEFAULT request_owner_id(),
  added_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (card_id, follower)
);

CREATE TABLE IF NOT EXISTS card_comments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id      uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  author       text NOT NULL CHECK (length(author) BETWEEN 1 AND 120),
  author_kind  text NOT NULL CHECK (author_kind IN ('person','agent','thread','system')),
  via          text NOT NULL CHECK (via IN ('dashboard','cli','thread','workflow','mail','migrated')),
  body         text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 2000),
  session_id   text,
  reply_to     uuid REFERENCES card_comments(id) ON DELETE SET NULL,
  edited_at    timestamptz,
  removed_at   timestamptz,
  removed_by   text,
  owner_id     text NOT NULL DEFAULT request_owner_id(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  fts          tsvector GENERATED ALWAYS AS (to_tsvector('english', body)) STORED
);

CREATE INDEX IF NOT EXISTS card_comments_card_time ON card_comments (card_id, created_at);
CREATE INDEX IF NOT EXISTS card_comments_fts ON card_comments USING gin (fts);
CREATE INDEX IF NOT EXISTS cards_parent ON cards (project, parent_key);

ALTER TABLE cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_followers ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_comments ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cards','card_followers','card_comments'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %1$s_select_policy ON %1$s', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$s_insert_policy ON %1$s', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$s_update_policy ON %1$s', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$s_delete_policy ON %1$s', t);
    EXECUTE format('CREATE POLICY %1$s_insert_policy ON %1$s FOR INSERT WITH CHECK (owner_id = request_owner_id())', t);
    EXECUTE format('CREATE POLICY %1$s_update_policy ON %1$s FOR UPDATE USING (owner_id = request_owner_id()) WITH CHECK (owner_id = request_owner_id())', t);
    EXECUTE format('CREATE POLICY %1$s_delete_policy ON %1$s FOR DELETE USING (owner_id = request_owner_id())', t);
  END LOOP;
END
$$;

-- Cards are team-visible like task_items; followers and comments are visible with their card.
CREATE POLICY cards_select_policy ON cards FOR SELECT USING (
  scope IN ('global','team') OR owner_id = request_owner_id()
  OR (SELECT keys.role FROM keys WHERE keys.hash = request_key_hash()) = 'admin');
CREATE POLICY card_followers_select_policy ON card_followers FOR SELECT USING (
  EXISTS (SELECT 1 FROM cards c WHERE c.id = card_id));
CREATE POLICY card_comments_select_policy ON card_comments FOR SELECT USING (
  EXISTS (SELECT 1 FROM cards c WHERE c.id = card_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON cards, card_followers, card_comments TO opencortex_memory_api;
