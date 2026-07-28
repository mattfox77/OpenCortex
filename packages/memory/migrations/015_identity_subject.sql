-- ============================================================
-- IDENTITY SUBJECT TRACKING
-- ============================================================
-- OIDC-authenticated memory writes carry the stable issuer subject so rows can
-- be audited independently from owner_id. Existing service-key writes may
-- leave this NULL during the Phase 4 additive rollout.
-- ============================================================

ALTER TABLE entries
  ADD COLUMN IF NOT EXISTS identity_subject TEXT;

ALTER TABLE log
  ADD COLUMN IF NOT EXISTS identity_subject TEXT;

ALTER TABLE artifacts
  ADD COLUMN IF NOT EXISTS identity_subject TEXT;

CREATE INDEX IF NOT EXISTS idx_entries_identity_subject
  ON entries(identity_subject);
CREATE INDEX IF NOT EXISTS idx_log_identity_subject
  ON log(identity_subject);
CREATE INDEX IF NOT EXISTS idx_artifacts_identity_subject
  ON artifacts(identity_subject);
