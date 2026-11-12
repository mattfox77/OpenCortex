-- 029_card_comment_type.sql
-- A card comment's message type (hopworker THREADS phase 1, D-20261111-16/18).
--
-- `hopworker card comment KEY --type notify|question|review|task` records what a comment is:
--   notify   says something (the default; every older row reads as notify)
--   question asks Matt something; it waits on him until he posts a later comment on the card,
--            or its author posts a notify comment replying to it (reply_to) that settles it
--   review   asks Matt to look at something (a decision frame); waits until a later Matt comment
--   task     work handed to someone
-- The card page shows the type as a chip and the dashboard's Inbox lists what waits on Matt.
-- Nothing reaches agents differently because of it (typed replies as instructions are phase 2).
--
-- Idempotent like 023/024/028: a re-run changes nothing. Readable and writable under the
-- card_comments policies already in place.

ALTER TABLE card_comments ADD COLUMN IF NOT EXISTS msg_type text NOT NULL DEFAULT 'notify';

ALTER TABLE card_comments DROP CONSTRAINT IF EXISTS card_comments_msg_type_check;
ALTER TABLE card_comments ADD CONSTRAINT card_comments_msg_type_check
  CHECK (msg_type IN ('notify','question','review','task'));

-- The Inbox's open questions and reviews: few rows, read on every dashboard load.
CREATE INDEX IF NOT EXISTS card_comments_asks ON card_comments (card_id, created_at)
  WHERE msg_type IN ('question','review') AND removed_at IS NULL;
