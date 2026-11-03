-- 027: Matt's to-dos (hopworker TD-… keys, 2026-11-03) have cards of their own kind.
ALTER TABLE cards DROP CONSTRAINT IF EXISTS cards_kind_check;
ALTER TABLE cards ADD CONSTRAINT cards_kind_check
  CHECK (kind = ANY (ARRAY['target', 'step', 'package', 'decision', 'commitment', 'todo', 'other']));
