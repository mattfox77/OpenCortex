-- ============================================================
-- WORKFLOW PROJECTION: Rebuildable read model for Temporal workflows
-- ============================================================
-- Temporal remains the source of truth. This table is a query-friendly cache
-- populated by workflow-completion activities and safe to rebuild.
-- ============================================================

CREATE TABLE IF NOT EXISTS workflow_projection (
  workflow_id       TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL,
  workflow_type     TEXT NOT NULL,
  status            TEXT NOT NULL
    CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  owner_id          TEXT NOT NULL,
  project           TEXT,
  source_system     TEXT,
  source_session_id TEXT,
  artifact_id       UUID REFERENCES artifacts(id) ON DELETE SET NULL,
  entry_ids         UUID[] DEFAULT '{}',
  summary           TEXT NOT NULL,
  data              JSONB DEFAULT '{}',
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_projection_status
  ON workflow_projection(status);
CREATE INDEX IF NOT EXISTS idx_workflow_projection_owner
  ON workflow_projection(owner_id);
CREATE INDEX IF NOT EXISTS idx_workflow_projection_project
  ON workflow_projection(project);
CREATE INDEX IF NOT EXISTS idx_workflow_projection_source_session
  ON workflow_projection(source_system, source_session_id);
CREATE INDEX IF NOT EXISTS idx_workflow_projection_completed
  ON workflow_projection(completed_at DESC);

DROP TRIGGER IF EXISTS workflow_projection_ts ON workflow_projection;
CREATE TRIGGER workflow_projection_ts BEFORE UPDATE ON workflow_projection
  FOR EACH ROW EXECUTE FUNCTION update_ts();

ALTER TABLE workflow_projection ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workflow_projection_select_policy ON workflow_projection;
CREATE POLICY workflow_projection_select_policy ON workflow_projection
  FOR SELECT
  USING (
    owner_id = request_owner_id()
    OR (SELECT role FROM keys WHERE hash = request_key_hash()) = 'admin'
  );

DROP POLICY IF EXISTS workflow_projection_insert_policy ON workflow_projection;
CREATE POLICY workflow_projection_insert_policy ON workflow_projection
  FOR INSERT
  WITH CHECK (owner_id = request_owner_id());

DROP POLICY IF EXISTS workflow_projection_update_policy ON workflow_projection;
CREATE POLICY workflow_projection_update_policy ON workflow_projection
  FOR UPDATE
  USING (owner_id = request_owner_id())
  WITH CHECK (owner_id = request_owner_id());

REVOKE ALL ON TABLE workflow_projection FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON workflow_projection TO opencortex_memory_api;
