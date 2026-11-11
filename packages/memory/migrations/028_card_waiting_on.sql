-- 028_card_waiting_on.sql
-- What a waiting or blocked delegate waits on (hopworker UNDERUSEDNOISE, D-20261111-12).
--
-- `hopworker card work KEY --state waiting|blocked --on OTHER` records OTHER, a card key (a
-- package, step, D-… or C-…), as the one thing the card's work waits on. The backlog's
-- under-used alert follows these links to name the blocking chain ("PREPCAP -> HOSTALLOW ->
-- REPLAYDB2"); nothing parses free text for it. hopworker clears it when the delegate is
-- working again, says done, or checks in without --on.
--
-- Idempotent like 023/024: a re-run changes nothing. Readable and writable under the cards
-- policies already in place.

ALTER TABLE cards ADD COLUMN IF NOT EXISTS waiting_on text;

ALTER TABLE cards DROP CONSTRAINT IF EXISTS cards_waiting_on_check;
ALTER TABLE cards ADD CONSTRAINT cards_waiting_on_check
  CHECK (waiting_on IS NULL OR (length(waiting_on) BETWEEN 1 AND 80 AND waiting_on !~ '[[:space:]/\\"''`<>]'));
