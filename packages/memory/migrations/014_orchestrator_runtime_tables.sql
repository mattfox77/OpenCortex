-- ============================================================
-- ORCHESTRATOR RUNTIME TABLES
-- ============================================================
-- Compatibility tables for the absorbed Temporal orchestrator activities.
-- Temporal remains the workflow authority; these tables hold audit/context
-- data used while the older CortexTask workflow is still present.
-- ============================================================

CREATE TABLE IF NOT EXISTS task_ledger (
  id                   UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  temporal_workflow_id TEXT NOT NULL,
  temporal_run_id      TEXT,
  task_type            TEXT NOT NULL DEFAULT 'custom',
  status               TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'planning', 'approved', 'running',
                      'completed', 'failed', 'cancelled')),
  input                JSONB NOT NULL DEFAULT '{}',
  output               JSONB DEFAULT '{}',
  error                TEXT,
  started_at           TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at           TIMESTAMPTZ DEFAULT now() NOT NULL,
  metadata             JSONB DEFAULT '{}'
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_task_ledger_workflow
  ON task_ledger(temporal_workflow_id);
CREATE INDEX IF NOT EXISTS idx_task_ledger_status
  ON task_ledger(status);
CREATE INDEX IF NOT EXISTS idx_task_ledger_created
  ON task_ledger(created_at DESC);

DROP TRIGGER IF EXISTS task_ledger_ts ON task_ledger;
CREATE TRIGGER task_ledger_ts BEFORE UPDATE ON task_ledger
  FOR EACH ROW EXECUTE FUNCTION update_ts();

CREATE TABLE IF NOT EXISTS workflow_context (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  workflow_id   TEXT NOT NULL,
  context_key   TEXT NOT NULL,
  context_value JSONB NOT NULL,
  updated_by    TEXT,
  created_at    TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at    TIMESTAMPTZ DEFAULT now() NOT NULL,
  UNIQUE(workflow_id, context_key)
);

CREATE INDEX IF NOT EXISTS idx_workflow_context_workflow
  ON workflow_context(workflow_id);

DROP TRIGGER IF EXISTS workflow_context_ts ON workflow_context;
CREATE TRIGGER workflow_context_ts BEFORE UPDATE ON workflow_context
  FOR EACH ROW EXECUTE FUNCTION update_ts();

ALTER TABLE task_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_context ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS task_ledger_admin_policy ON task_ledger;
CREATE POLICY task_ledger_admin_policy ON task_ledger
  FOR ALL
  USING (request_is_admin())
  WITH CHECK (request_is_admin());

DROP POLICY IF EXISTS workflow_context_admin_policy ON workflow_context;
CREATE POLICY workflow_context_admin_policy ON workflow_context
  FOR ALL
  USING (request_is_admin())
  WITH CHECK (request_is_admin());

REVOKE ALL ON TABLE task_ledger FROM PUBLIC;
REVOKE ALL ON TABLE workflow_context FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON task_ledger TO opencortex_memory_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON workflow_context TO opencortex_memory_api;
