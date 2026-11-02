-- 024_card_workers.sql
-- Who is working a card now (Matt 2026-11-02: "see who (agents or people) are active on it").
--
-- A card has one accountable person (assignee: Matt by default; only he, from the dashboard,
-- or code defaults set it) and at most one delegate: the agent role or issue thread doing the
-- work, with its state. A worker can't replace another live delegate, only take a card with
-- none, its own, or a stale one; hopworker enforces that, the table records it.
--
-- card_workers holds check-ins (`hopworker card work KEY`): which session or thread said it is
-- on the card, since when, last seen, and when it said done. Running loops and the card's
-- thread are read live by hopworker, not stored. An hourly sweep marks a delegate silent for
-- 24 hours stale.
--
-- Idempotent like 023: a re-run changes nothing.

ALTER TABLE cards ADD COLUMN IF NOT EXISTS assignee text NOT NULL DEFAULT 'matt';
ALTER TABLE cards ADD COLUMN IF NOT EXISTS delegate text;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS agent_state text;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS state_at timestamptz;

ALTER TABLE cards DROP CONSTRAINT IF EXISTS cards_agent_state_check;
ALTER TABLE cards ADD CONSTRAINT cards_agent_state_check
  CHECK (agent_state IS NULL OR agent_state IN ('working','waiting','blocked','done','stale'));
ALTER TABLE cards DROP CONSTRAINT IF EXISTS cards_delegate_check;
ALTER TABLE cards ADD CONSTRAINT cards_delegate_check
  CHECK (delegate IS NULL OR length(delegate) BETWEEN 1 AND 120);

CREATE TABLE IF NOT EXISTS card_workers (
  card_id     uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  worker      text NOT NULL,
  kind        text NOT NULL,
  session_id  text,
  since       timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  done_at     timestamptz,
  owner_id    text NOT NULL DEFAULT request_owner_id(),
  PRIMARY KEY (card_id, worker)
);

ALTER TABLE card_workers DROP CONSTRAINT IF EXISTS card_workers_kind_check;
ALTER TABLE card_workers ADD CONSTRAINT card_workers_kind_check CHECK (kind IN ('session','thread'));
ALTER TABLE card_workers DROP CONSTRAINT IF EXISTS card_workers_worker_check;
ALTER TABLE card_workers ADD CONSTRAINT card_workers_worker_check CHECK (length(worker) BETWEEN 1 AND 120);

CREATE INDEX IF NOT EXISTS card_workers_seen ON card_workers (last_seen DESC);
CREATE INDEX IF NOT EXISTS cards_delegate ON cards (project, delegate) WHERE delegate IS NOT NULL;

ALTER TABLE card_workers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS card_workers_select_policy ON card_workers;
DROP POLICY IF EXISTS card_workers_insert_policy ON card_workers;
DROP POLICY IF EXISTS card_workers_update_policy ON card_workers;
DROP POLICY IF EXISTS card_workers_delete_policy ON card_workers;
CREATE POLICY card_workers_insert_policy ON card_workers FOR INSERT WITH CHECK (owner_id = request_owner_id());
CREATE POLICY card_workers_update_policy ON card_workers FOR UPDATE USING (owner_id = request_owner_id()) WITH CHECK (owner_id = request_owner_id());
CREATE POLICY card_workers_delete_policy ON card_workers FOR DELETE USING (owner_id = request_owner_id());
-- Visible with their card, like followers and comments.
CREATE POLICY card_workers_select_policy ON card_workers FOR SELECT USING (
  EXISTS (SELECT 1 FROM cards c WHERE c.id = card_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON card_workers TO opencortex_memory_api;
