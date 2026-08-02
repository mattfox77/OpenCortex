-- ============================================================
-- REVIEW STATES: Phase 6 workflow-driven review decisions
-- ============================================================

ALTER TABLE entries DROP CONSTRAINT IF EXISTS entries_review_check;

ALTER TABLE entries
  ADD CONSTRAINT entries_review_check
  CHECK (review IN (
    'approved',
    'pending',
    'archived',
    'rejected',
    'noise',
    'changes_requested'
  ));
