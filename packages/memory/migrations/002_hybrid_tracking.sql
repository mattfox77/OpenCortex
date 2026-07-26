-- ============================================================
-- MIGRATION: Hybrid search + session-group tracking
-- ============================================================
-- Safe to run on existing BrainTrust deployments.
-- All ADD COLUMN uses IF NOT EXISTS (Postgres 9.6+).
-- Run after 01-schema.sql on fresh installs; run standalone on upgrades.
-- ============================================================

-- entries: session/tool/repo tracking columns
ALTER TABLE entries ADD COLUMN IF NOT EXISTS source_system TEXT;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS source_session_id TEXT;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS repo TEXT;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS tool_name TEXT;

-- artifacts: tool tracking
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS tool_name TEXT;

-- entries indexes for hybrid search + session grouping
CREATE INDEX IF NOT EXISTS idx_entries_source_system ON entries(source_system);
CREATE INDEX IF NOT EXISTS idx_entries_source_session ON entries(source_session_id);
CREATE INDEX IF NOT EXISTS idx_entries_repo ON entries(repo);
CREATE INDEX IF NOT EXISTS idx_entries_tool ON entries(tool_name);
CREATE INDEX IF NOT EXISTS idx_entries_repo_project ON entries(repo, project);
CREATE INDEX IF NOT EXISTS idx_entries_session_lookup ON entries(source_system, source_session_id);

-- artifacts indexes for tool filtering
CREATE INDEX IF NOT EXISTS idx_artifacts_tool ON artifacts(tool_name);
