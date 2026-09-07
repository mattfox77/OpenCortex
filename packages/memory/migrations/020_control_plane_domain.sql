-- ============================================================
-- CONTROL PLANE DOMAIN: Slice 1 provider-neutral records
-- ============================================================
-- Additive schema for tenant-scoped tasks, workbenches, provider sessions,
-- classroom/cohort objects, and compatibility migration from code-sessions.json.
-- Runtime continues to keep legacy session JSON readable during this rollout.
-- ============================================================

CREATE TABLE IF NOT EXISTS tenants (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS tenant_memberships (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subject     TEXT NOT NULL,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL
    CHECK (role IN ('owner', 'operator', 'reviewer', 'observer', 'class_admin',
                    'teacher', 'teaching_assistant', 'student', 'auditor')),
  scopes      JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
  UNIQUE(tenant_id, subject, role)
);

CREATE TABLE IF NOT EXISTS agent_tasks (
  id                     TEXT PRIMARY KEY,
  tenant_id              TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_subject          TEXT NOT NULL,
  owner_email            TEXT NOT NULL,
  title                  TEXT NOT NULL,
  description            TEXT NOT NULL DEFAULT '',
  status                 TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'blocked', 'review', 'completed', 'archived')),
  cohort_id              TEXT,
  assignment_instance_id TEXT,
  metadata               JSONB NOT NULL DEFAULT '{}',
  created_at             TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at             TIMESTAMPTZ DEFAULT now() NOT NULL,
  archived_at            TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS work_references (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id         TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL
    CHECK (kind IN ('jira', 'github_issue', 'github_pr', 'manual', 'link',
                    'note', 'repository', 'file', 'artifact')),
  external_id     TEXT,
  url             TEXT,
  title           TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at      TIMESTAMPTZ DEFAULT now() NOT NULL,
  archived_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS workbenches (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id             TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  owner_subject       TEXT NOT NULL,
  owner_email         TEXT NOT NULL,
  linux_user          TEXT NOT NULL,
  name                TEXT,
  status              TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'starting', 'running', 'stopped', 'archived',
                      'unknown')),
  workspace_dir       TEXT,
  host_id             TEXT,
  legacy_session_id   TEXT,
  migration_metadata  JSONB NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at          TIMESTAMPTZ DEFAULT now() NOT NULL,
  archived_at         TIMESTAMPTZ,
  UNIQUE(tenant_id, legacy_session_id)
);

CREATE TABLE IF NOT EXISTS provider_sessions (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workbench_id       TEXT NOT NULL REFERENCES workbenches(id) ON DELETE CASCADE,
  provider_id        TEXT NOT NULL,
  provider_version   TEXT,
  native_session_id  TEXT,
  status             TEXT NOT NULL DEFAULT 'unknown'
    CHECK (status IN ('active', 'running', 'idle', 'blocked', 'completed',
                      'archived', 'unknown')),
  metadata           JSONB NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at         TIMESTAMPTZ DEFAULT now() NOT NULL,
  archived_at        TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS hosts (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'unknown'
    CHECK (status IN ('online', 'stale', 'offline', 'unknown', 'archived')),
  labels      JSONB NOT NULL DEFAULT '[]',
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
  archived_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS host_user_capabilities (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  host_id     TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  subject     TEXT NOT NULL,
  linux_user  TEXT NOT NULL,
  providers   JSONB NOT NULL DEFAULT '[]',
  tools       JSONB NOT NULL DEFAULT '[]',
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
  UNIQUE(host_id, subject, linux_user)
);

CREATE TABLE IF NOT EXISTS worktrees (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id     TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  host_id     TEXT,
  repo_url    TEXT,
  path        TEXT NOT NULL,
  branch      TEXT,
  base_ref    TEXT,
  status      TEXT NOT NULL DEFAULT 'unknown'
    CHECK (status IN ('ready', 'dirty', 'conflicted', 'archived', 'unknown')),
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
  archived_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS context_packs (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id     TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  checksum    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'ready', 'used', 'archived')),
  manifest    JSONB NOT NULL DEFAULT '{}',
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
  UNIQUE(task_id, version)
);

CREATE TABLE IF NOT EXISTS review_requests (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id      TEXT REFERENCES agent_tasks(id) ON DELETE CASCADE,
  workbench_id TEXT REFERENCES workbenches(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'general',
  status       TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'changes_requested',
                      'cancelled', 'archived')),
  requested_by TEXT NOT NULL,
  reviewer     TEXT,
  metadata     JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at   TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS cohorts (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
  archived_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS cohort_enrollments (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cohort_id   TEXT NOT NULL REFERENCES cohorts(id) ON DELETE CASCADE,
  subject     TEXT NOT NULL,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL
    CHECK (role IN ('class_admin', 'teacher', 'teaching_assistant', 'student',
                    'auditor')),
  status      TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('invited', 'active', 'removed')),
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
  UNIQUE(cohort_id, subject, role)
);

CREATE TABLE IF NOT EXISTS assignment_templates (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cohort_id   TEXT REFERENCES cohorts(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  objective   TEXT NOT NULL DEFAULT '',
  policy      JSONB NOT NULL DEFAULT '{}',
  rubric      JSONB NOT NULL DEFAULT '{}',
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
  archived_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS assignment_instances (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  template_id   TEXT NOT NULL REFERENCES assignment_templates(id) ON DELETE CASCADE,
  cohort_id     TEXT REFERENCES cohorts(id) ON DELETE SET NULL,
  task_id       TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL,
  assignee      TEXT NOT NULL,
  assignee_email TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'assigned'
    CHECK (status IN ('assigned', 'in_progress', 'submitted', 'reviewed',
                      'returned', 'archived')),
  due_at        TIMESTAMPTZ,
  metadata      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at    TIMESTAMPTZ DEFAULT now() NOT NULL,
  UNIQUE(template_id, assignee)
);

CREATE TABLE IF NOT EXISTS session_share_grants (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workbench_id TEXT NOT NULL REFERENCES workbenches(id) ON DELETE CASCADE,
  grantee      TEXT NOT NULL,
  mode         TEXT NOT NULL
    CHECK (mode IN ('observe', 'annotate', 'assist', 'pair', 'takeover',
                    'handoff', 'review-only', 'replay-only')),
  status       TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('pending', 'active', 'revoked', 'expired')),
  reason       TEXT,
  created_by   TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT now() NOT NULL,
  expires_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS submissions (
  id                     TEXT PRIMARY KEY,
  tenant_id              TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  assignment_instance_id TEXT REFERENCES assignment_instances(id) ON DELETE SET NULL,
  task_id                TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  submitted_by           TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('draft', 'submitted', 'returned', 'accepted', 'rejected',
                      'reviewed', 'archived')),
  artifacts              JSONB NOT NULL DEFAULT '[]',
  rubric_results         JSONB NOT NULL DEFAULT '{}',
  created_at             TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at             TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tenant_memberships_email
  ON tenant_memberships(tenant_id, email);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_tenant_owner
  ON agent_tasks(tenant_id, owner_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_classroom
  ON agent_tasks(tenant_id, cohort_id, assignment_instance_id);
CREATE INDEX IF NOT EXISTS idx_work_references_task
  ON work_references(tenant_id, task_id);
CREATE INDEX IF NOT EXISTS idx_workbenches_task
  ON workbenches(tenant_id, task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workbenches_owner
  ON workbenches(tenant_id, owner_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_provider_sessions_workbench
  ON provider_sessions(tenant_id, workbench_id);
CREATE INDEX IF NOT EXISTS idx_hosts_tenant_status
  ON hosts(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_host_user_capabilities_subject
  ON host_user_capabilities(tenant_id, subject);
CREATE INDEX IF NOT EXISTS idx_worktrees_task
  ON worktrees(tenant_id, task_id);
CREATE INDEX IF NOT EXISTS idx_context_packs_task
  ON context_packs(tenant_id, task_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_review_requests_task
  ON review_requests(tenant_id, task_id, status);
CREATE INDEX IF NOT EXISTS idx_cohorts_tenant_status
  ON cohorts(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_cohort_enrollments_subject
  ON cohort_enrollments(tenant_id, subject);
CREATE INDEX IF NOT EXISTS idx_assignment_templates_cohort
  ON assignment_templates(tenant_id, cohort_id);
CREATE INDEX IF NOT EXISTS idx_assignment_instances_assignee
  ON assignment_instances(tenant_id, assignee);
CREATE INDEX IF NOT EXISTS idx_session_share_grants_grantee
  ON session_share_grants(tenant_id, grantee, status);
CREATE INDEX IF NOT EXISTS idx_submissions_task
  ON submissions(tenant_id, task_id);

DROP TRIGGER IF EXISTS tenants_ts ON tenants;
CREATE TRIGGER tenants_ts BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION update_ts();
DROP TRIGGER IF EXISTS tenant_memberships_ts ON tenant_memberships;
CREATE TRIGGER tenant_memberships_ts BEFORE UPDATE ON tenant_memberships
  FOR EACH ROW EXECUTE FUNCTION update_ts();
DROP TRIGGER IF EXISTS agent_tasks_ts ON agent_tasks;
CREATE TRIGGER agent_tasks_ts BEFORE UPDATE ON agent_tasks
  FOR EACH ROW EXECUTE FUNCTION update_ts();
DROP TRIGGER IF EXISTS work_references_ts ON work_references;
CREATE TRIGGER work_references_ts BEFORE UPDATE ON work_references
  FOR EACH ROW EXECUTE FUNCTION update_ts();
DROP TRIGGER IF EXISTS workbenches_ts ON workbenches;
CREATE TRIGGER workbenches_ts BEFORE UPDATE ON workbenches
  FOR EACH ROW EXECUTE FUNCTION update_ts();
DROP TRIGGER IF EXISTS provider_sessions_ts ON provider_sessions;
CREATE TRIGGER provider_sessions_ts BEFORE UPDATE ON provider_sessions
  FOR EACH ROW EXECUTE FUNCTION update_ts();
DROP TRIGGER IF EXISTS hosts_ts ON hosts;
CREATE TRIGGER hosts_ts BEFORE UPDATE ON hosts
  FOR EACH ROW EXECUTE FUNCTION update_ts();
DROP TRIGGER IF EXISTS host_user_capabilities_ts ON host_user_capabilities;
CREATE TRIGGER host_user_capabilities_ts BEFORE UPDATE ON host_user_capabilities
  FOR EACH ROW EXECUTE FUNCTION update_ts();
DROP TRIGGER IF EXISTS worktrees_ts ON worktrees;
CREATE TRIGGER worktrees_ts BEFORE UPDATE ON worktrees
  FOR EACH ROW EXECUTE FUNCTION update_ts();
DROP TRIGGER IF EXISTS review_requests_ts ON review_requests;
CREATE TRIGGER review_requests_ts BEFORE UPDATE ON review_requests
  FOR EACH ROW EXECUTE FUNCTION update_ts();
DROP TRIGGER IF EXISTS cohorts_ts ON cohorts;
CREATE TRIGGER cohorts_ts BEFORE UPDATE ON cohorts
  FOR EACH ROW EXECUTE FUNCTION update_ts();
DROP TRIGGER IF EXISTS cohort_enrollments_ts ON cohort_enrollments;
CREATE TRIGGER cohort_enrollments_ts BEFORE UPDATE ON cohort_enrollments
  FOR EACH ROW EXECUTE FUNCTION update_ts();
DROP TRIGGER IF EXISTS assignment_templates_ts ON assignment_templates;
CREATE TRIGGER assignment_templates_ts BEFORE UPDATE ON assignment_templates
  FOR EACH ROW EXECUTE FUNCTION update_ts();
DROP TRIGGER IF EXISTS assignment_instances_ts ON assignment_instances;
CREATE TRIGGER assignment_instances_ts BEFORE UPDATE ON assignment_instances
  FOR EACH ROW EXECUTE FUNCTION update_ts();
DROP TRIGGER IF EXISTS submissions_ts ON submissions;
CREATE TRIGGER submissions_ts BEFORE UPDATE ON submissions
  FOR EACH ROW EXECUTE FUNCTION update_ts();

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE workbenches ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hosts ENABLE ROW LEVEL SECURITY;
ALTER TABLE host_user_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE worktrees ENABLE ROW LEVEL SECURITY;
ALTER TABLE context_packs ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE cohorts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cohort_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignment_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignment_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_share_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenants_admin_policy ON tenants;
CREATE POLICY tenants_admin_policy ON tenants
  FOR ALL USING (request_is_admin()) WITH CHECK (request_is_admin());
DROP POLICY IF EXISTS tenant_memberships_admin_policy ON tenant_memberships;
CREATE POLICY tenant_memberships_admin_policy ON tenant_memberships
  FOR ALL USING (request_is_admin()) WITH CHECK (request_is_admin());
DROP POLICY IF EXISTS agent_tasks_admin_policy ON agent_tasks;
CREATE POLICY agent_tasks_admin_policy ON agent_tasks
  FOR ALL USING (request_is_admin()) WITH CHECK (request_is_admin());
DROP POLICY IF EXISTS work_references_admin_policy ON work_references;
CREATE POLICY work_references_admin_policy ON work_references
  FOR ALL USING (request_is_admin()) WITH CHECK (request_is_admin());
DROP POLICY IF EXISTS workbenches_admin_policy ON workbenches;
CREATE POLICY workbenches_admin_policy ON workbenches
  FOR ALL USING (request_is_admin()) WITH CHECK (request_is_admin());
DROP POLICY IF EXISTS provider_sessions_admin_policy ON provider_sessions;
CREATE POLICY provider_sessions_admin_policy ON provider_sessions
  FOR ALL USING (request_is_admin()) WITH CHECK (request_is_admin());
DROP POLICY IF EXISTS hosts_admin_policy ON hosts;
CREATE POLICY hosts_admin_policy ON hosts
  FOR ALL USING (request_is_admin()) WITH CHECK (request_is_admin());
DROP POLICY IF EXISTS host_user_capabilities_admin_policy ON host_user_capabilities;
CREATE POLICY host_user_capabilities_admin_policy ON host_user_capabilities
  FOR ALL USING (request_is_admin()) WITH CHECK (request_is_admin());
DROP POLICY IF EXISTS worktrees_admin_policy ON worktrees;
CREATE POLICY worktrees_admin_policy ON worktrees
  FOR ALL USING (request_is_admin()) WITH CHECK (request_is_admin());
DROP POLICY IF EXISTS context_packs_admin_policy ON context_packs;
CREATE POLICY context_packs_admin_policy ON context_packs
  FOR ALL USING (request_is_admin()) WITH CHECK (request_is_admin());
DROP POLICY IF EXISTS review_requests_admin_policy ON review_requests;
CREATE POLICY review_requests_admin_policy ON review_requests
  FOR ALL USING (request_is_admin()) WITH CHECK (request_is_admin());
DROP POLICY IF EXISTS cohorts_admin_policy ON cohorts;
CREATE POLICY cohorts_admin_policy ON cohorts
  FOR ALL USING (request_is_admin()) WITH CHECK (request_is_admin());
DROP POLICY IF EXISTS cohort_enrollments_admin_policy ON cohort_enrollments;
CREATE POLICY cohort_enrollments_admin_policy ON cohort_enrollments
  FOR ALL USING (request_is_admin()) WITH CHECK (request_is_admin());
DROP POLICY IF EXISTS assignment_templates_admin_policy ON assignment_templates;
CREATE POLICY assignment_templates_admin_policy ON assignment_templates
  FOR ALL USING (request_is_admin()) WITH CHECK (request_is_admin());
DROP POLICY IF EXISTS assignment_instances_admin_policy ON assignment_instances;
CREATE POLICY assignment_instances_admin_policy ON assignment_instances
  FOR ALL USING (request_is_admin()) WITH CHECK (request_is_admin());
DROP POLICY IF EXISTS session_share_grants_admin_policy ON session_share_grants;
CREATE POLICY session_share_grants_admin_policy ON session_share_grants
  FOR ALL USING (request_is_admin()) WITH CHECK (request_is_admin());
DROP POLICY IF EXISTS submissions_admin_policy ON submissions;
CREATE POLICY submissions_admin_policy ON submissions
  FOR ALL USING (request_is_admin()) WITH CHECK (request_is_admin());

REVOKE ALL ON TABLE
  tenants,
  tenant_memberships,
  agent_tasks,
  work_references,
  workbenches,
  provider_sessions,
  hosts,
  host_user_capabilities,
  worktrees,
  context_packs,
  review_requests,
  cohorts,
  cohort_enrollments,
  assignment_templates,
  assignment_instances,
  session_share_grants,
  submissions
FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  tenants,
  tenant_memberships,
  agent_tasks,
  work_references,
  workbenches,
  provider_sessions,
  hosts,
  host_user_capabilities,
  worktrees,
  context_packs,
  review_requests,
  cohorts,
  cohort_enrollments,
  assignment_templates,
  assignment_instances,
  session_share_grants,
  submissions
TO opencortex_memory_api;
