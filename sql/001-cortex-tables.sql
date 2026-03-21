-- ============================================================
-- Open Cortex: Database Extension for Open Brain
-- ============================================================
-- Run this in your Supabase SQL Editor AFTER you've set up
-- Open Brain (you should already have the 'thoughts' table).
--
-- This adds three tables:
--   1. worker_registry  — every CLI instance registers itself
--   2. task_ledger      — audit trail for every task
--   3. workflow_context — shared scratchpad between workers
-- ============================================================

-- 1. Worker Registry
-- Each machine running a CLI agent registers here.
-- Your brain now knows who's available to do work.
CREATE TABLE IF NOT EXISTS worker_registry (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  worker_name TEXT NOT NULL UNIQUE,
  worker_type TEXT NOT NULL DEFAULT 'claude-code',
  task_queues TEXT[] NOT NULL DEFAULT '{}',
  capabilities TEXT[] NOT NULL DEFAULT '{}',
  machine_info JSONB DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'offline',
  last_heartbeat TIMESTAMPTZ DEFAULT now(),
  registered_at TIMESTAMPTZ DEFAULT now(),
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_worker_status ON worker_registry(status);
CREATE INDEX IF NOT EXISTS idx_worker_heartbeat ON worker_registry(last_heartbeat);

-- 2. Task Ledger
-- Every task that flows through the system gets recorded.
-- When something goes wrong at 3 AM, you query this table.
CREATE TABLE IF NOT EXISTS task_ledger (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  temporal_workflow_id TEXT NOT NULL,
  temporal_run_id TEXT,
  task_type TEXT NOT NULL DEFAULT 'custom',
  status TEXT NOT NULL DEFAULT 'pending',
  worker_id UUID REFERENCES worker_registry(id),
  input JSONB NOT NULL DEFAULT '{}',
  output JSONB DEFAULT '{}',
  error TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_ledger_workflow ON task_ledger(temporal_workflow_id);
CREATE INDEX IF NOT EXISTS idx_ledger_status ON task_ledger(status);

-- 3. Workflow Context
-- Shared scratchpad for multi-step workflows.
-- Worker #1 leaves a note, Worker #2 picks it up automatically.
CREATE TABLE IF NOT EXISTS workflow_context (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  context_key TEXT NOT NULL,
  context_value JSONB NOT NULL,
  updated_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(workflow_id, context_key)
);

CREATE INDEX IF NOT EXISTS idx_context_workflow ON workflow_context(workflow_id);

-- Row Level Security (same pattern as Open Brain)
ALTER TABLE worker_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_context ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON worker_registry
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access" ON task_ledger
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access" ON workflow_context
  FOR ALL USING (auth.role() = 'service_role');

-- ============================================================
-- Done! You should now see three new tables in Table Editor:
--   worker_registry, task_ledger, workflow_context
-- ============================================================
