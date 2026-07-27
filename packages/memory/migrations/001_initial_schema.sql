-- ============================================================
-- BRAINTRUST SCHEMA
-- ============================================================
-- 5 tables. Run once on fresh Postgres with pgvector.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- ENTRIES: Everything searchable
-- ============================================================

CREATE TABLE IF NOT EXISTS entries (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at    TIMESTAMPTZ DEFAULT now() NOT NULL,
  content       TEXT NOT NULL,
  title         TEXT,
  embedding     vector(768),
  fts           TSVECTOR GENERATED ALWAYS AS
                  (to_tsvector('english', coalesce(title, '') || ' ' || content)) STORED,
  kind          TEXT NOT NULL DEFAULT 'thought'
    CHECK (kind IN ('thought', 'finding', 'decision', 'document', 'chunk')),
  parent_id     UUID REFERENCES entries(id) ON DELETE CASCADE,
  chunk_index   INTEGER,
  heading       TEXT,
  project       TEXT,
  scope         TEXT NOT NULL DEFAULT 'team'
    CHECK (scope IN ('personal', 'team', 'global')),
  owner_id      TEXT NOT NULL,
  author        TEXT NOT NULL DEFAULT 'user'
    CHECK (author IN ('user', 'agent')),
  review        TEXT NOT NULL DEFAULT 'approved'
    CHECK (review IN ('approved', 'pending', 'archived')),
  tags          TEXT[] DEFAULT '{}',
  meta          JSONB DEFAULT '{}',
  content_hash  TEXT,
  source_system TEXT,
  source_session_id TEXT,
  repo          TEXT,
  tool_name     TEXT
);

CREATE INDEX IF NOT EXISTS idx_entries_embedding ON entries
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS idx_entries_fts ON entries USING GIN(fts);
CREATE INDEX IF NOT EXISTS idx_entries_project ON entries(project);
CREATE INDEX IF NOT EXISTS idx_entries_scope ON entries(scope);
CREATE INDEX IF NOT EXISTS idx_entries_owner ON entries(owner_id);
CREATE INDEX IF NOT EXISTS idx_entries_kind ON entries(kind);
CREATE INDEX IF NOT EXISTS idx_entries_parent ON entries(parent_id);
CREATE INDEX IF NOT EXISTS idx_entries_created ON entries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_hash ON entries(content_hash);
CREATE INDEX IF NOT EXISTS idx_entries_tags ON entries USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_entries_review ON entries(review);
CREATE INDEX IF NOT EXISTS idx_entries_source_system ON entries(source_system);
CREATE INDEX IF NOT EXISTS idx_entries_source_session ON entries(source_session_id);
CREATE INDEX IF NOT EXISTS idx_entries_repo ON entries(repo);
CREATE INDEX IF NOT EXISTS idx_entries_tool ON entries(tool_name);
CREATE INDEX IF NOT EXISTS idx_entries_repo_project ON entries(repo, project);
CREATE INDEX IF NOT EXISTS idx_entries_session_lookup ON entries(source_system, source_session_id);

CREATE OR REPLACE FUNCTION auto_review() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.author = 'agent' AND NEW.review = 'approved' THEN
    NEW.review = 'pending';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS entries_auto_review ON entries;
CREATE TRIGGER entries_auto_review
  BEFORE INSERT ON entries FOR EACH ROW EXECUTE FUNCTION auto_review();

-- ============================================================
-- LOG: Structured events (append-only)
-- ============================================================

CREATE TABLE IF NOT EXISTS log (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  ts            TIMESTAMPTZ DEFAULT now() NOT NULL,
  kind          TEXT NOT NULL
    CHECK (kind IN ('build', 'deploy', 'test', 'error', 'decision',
                    'milestone', 'approval', 'capture', 'ingest', 'review')),
  status        TEXT
    CHECK (status IS NULL OR status IN ('pass', 'fail', 'pending',
                    'cancelled', 'skipped', 'partial')),
  summary       TEXT NOT NULL,
  project       TEXT,
  owner_id      TEXT,
  worker        TEXT,
  data          JSONB DEFAULT '{}',
  entry_id      UUID REFERENCES entries(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_log_ts ON log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_log_kind ON log(kind);
CREATE INDEX IF NOT EXISTS idx_log_project ON log(project);
CREATE INDEX IF NOT EXISTS idx_log_status ON log(status);
CREATE INDEX IF NOT EXISTS idx_log_worker ON log(worker);

-- ============================================================
-- ARTIFACTS: Durable original file storage index (S3 pointers)
-- ============================================================

CREATE TABLE IF NOT EXISTS artifacts (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at      TIMESTAMPTZ DEFAULT now() NOT NULL,
  source_system   TEXT NOT NULL,
  source_path     TEXT NOT NULL,
  source_session_id TEXT,
  project         TEXT,
  repo            TEXT,
  repo_root       TEXT,
  session_group   TEXT,
  scope           TEXT NOT NULL DEFAULT 'personal'
    CHECK (scope IN ('personal', 'team', 'global')),
  owner_id        TEXT NOT NULL,
  sha256          TEXT NOT NULL,
  size_bytes      BIGINT NOT NULL,
  mime_type       TEXT,
  storage_uri     TEXT,
  storage_key     TEXT,
  tool_name       TEXT,
  meta            JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_artifacts_created ON artifacts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_source ON artifacts(source_system);
CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts(project);
CREATE INDEX IF NOT EXISTS idx_artifacts_repo ON artifacts(repo);
CREATE INDEX IF NOT EXISTS idx_artifacts_session_group ON artifacts(session_group);
CREATE INDEX IF NOT EXISTS idx_artifacts_scope ON artifacts(scope);
CREATE INDEX IF NOT EXISTS idx_artifacts_owner ON artifacts(owner_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_sha256 ON artifacts(sha256);
CREATE INDEX IF NOT EXISTS idx_artifacts_source_path ON artifacts(source_path);
CREATE INDEX IF NOT EXISTS idx_artifacts_tool ON artifacts(tool_name);
CREATE UNIQUE INDEX IF NOT EXISTS uq_artifacts_source_path_sha
  ON artifacts(source_system, source_path, sha256);

CREATE TABLE IF NOT EXISTS artifact_links (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at      TIMESTAMPTZ DEFAULT now() NOT NULL,
  artifact_id     UUID NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  entry_id        UUID REFERENCES entries(id) ON DELETE CASCADE,
  log_id          UUID REFERENCES log(id) ON DELETE CASCADE,
  relationship    TEXT NOT NULL DEFAULT 'raw_of',
  owner_id        TEXT NOT NULL,
  meta            JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_artifact_links_artifact ON artifact_links(artifact_id);
CREATE INDEX IF NOT EXISTS idx_artifact_links_entry ON artifact_links(entry_id);
CREATE INDEX IF NOT EXISTS idx_artifact_links_log ON artifact_links(log_id);
CREATE INDEX IF NOT EXISTS idx_artifact_links_owner ON artifact_links(owner_id);

CREATE TABLE IF NOT EXISTS sync_state (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at      TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at      TIMESTAMPTZ DEFAULT now() NOT NULL,
  source_system   TEXT NOT NULL,
  owner_id        TEXT NOT NULL,
  project         TEXT,
  repo            TEXT,
  last_cursor     TEXT,
  last_run_at     TIMESTAMPTZ,
  status          TEXT DEFAULT 'idle'
    CHECK (status IN ('idle', 'running', 'ok', 'failed')),
  stats           JSONB DEFAULT '{}',
  error           TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_state_source_owner_project_repo
  ON sync_state(source_system, owner_id, COALESCE(project, ''), COALESCE(repo, ''));

-- ============================================================
-- TASKS: Coordination
-- ============================================================

CREATE TABLE IF NOT EXISTS tasks (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at    TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at    TIMESTAMPTZ DEFAULT now() NOT NULL,
  workflow_id   TEXT NOT NULL,
  name          TEXT NOT NULL,
  kind          TEXT,
  worker        TEXT,
  queue         TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'done', 'failed',
                      'waiting', 'cancelled')),
  input         JSONB DEFAULT '{}',
  output        JSONB DEFAULT '{}',
  error         TEXT,
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  entry_ids     UUID[] DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_workflow ON tasks(workflow_id);
CREATE INDEX IF NOT EXISTS idx_tasks_worker ON tasks(worker);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);

CREATE OR REPLACE FUNCTION update_ts() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tasks_ts ON tasks;
CREATE TRIGGER tasks_ts BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION update_ts();

DROP TRIGGER IF EXISTS sync_state_ts ON sync_state;
CREATE TRIGGER sync_state_ts BEFORE UPDATE ON sync_state
  FOR EACH ROW EXECUTE FUNCTION update_ts();

-- ============================================================
-- WORKERS: Registry
-- ============================================================

CREATE TABLE IF NOT EXISTS workers (
  name          TEXT PRIMARY KEY,
  kind          TEXT NOT NULL DEFAULT 'opencode',
  queues        TEXT[] DEFAULT '{}',
  capabilities  TEXT[] DEFAULT '{}',
  machine       JSONB DEFAULT '{}',
  status        TEXT DEFAULT 'offline'
    CHECK (status IN ('online', 'offline', 'busy')),
  heartbeat     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workers_status ON workers(status);

-- ============================================================
-- KEYS: Multi-user auth
-- ============================================================

CREATE TABLE IF NOT EXISTS keys (
  hash          TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  name          TEXT,
  role          TEXT DEFAULT 'member'
    CHECK (role IN ('admin', 'member', 'agent')),
  created_at    TIMESTAMPTZ DEFAULT now(),
  last_used     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_keys_owner ON keys(owner_id);

-- ============================================================
-- IDENTITIES: OIDC/runtime identity mapping + provisioned service keys
-- ============================================================

CREATE TABLE IF NOT EXISTS identities (
  provider      TEXT NOT NULL,
  subject       TEXT NOT NULL,
  email         TEXT NOT NULL,
  owner_id      TEXT NOT NULL,
  name          TEXT,
  role          TEXT NOT NULL DEFAULT 'member'
    CHECK (role IN ('admin', 'member', 'agent')),
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  last_login    TIMESTAMPTZ,
  disabled_at   TIMESTAMPTZ,
  PRIMARY KEY (provider, subject),
  UNIQUE (provider, email)
);

CREATE INDEX IF NOT EXISTS idx_identities_owner ON identities(owner_id);
CREATE INDEX IF NOT EXISTS idx_identities_email ON identities(provider, email);

CREATE TABLE IF NOT EXISTS provisioned_credentials (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      TEXT NOT NULL,
  subject       TEXT NOT NULL,
  owner_id      TEXT NOT NULL,
  kind          TEXT NOT NULL
    CHECK (kind IN ('brain')),
  key_hash      TEXT NOT NULL,
  key_prefix    TEXT NOT NULL,
  managed_by    TEXT NOT NULL DEFAULT 'brain-auth-broker',
  created_at    TIMESTAMPTZ DEFAULT now(),
  rotated_at    TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  meta          JSONB NOT NULL DEFAULT '{}'::JSONB,
  UNIQUE (kind, key_hash)
);

CREATE INDEX IF NOT EXISTS idx_provisioned_credentials_identity
  ON provisioned_credentials(provider, subject);
CREATE INDEX IF NOT EXISTS idx_provisioned_credentials_owner
  ON provisioned_credentials(owner_id);

-- ============================================================
-- REQUEST CONTEXT HELPERS + API ROLE
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opencortex_memory_api') THEN
    CREATE ROLE opencortex_memory_api NOLOGIN;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION request_api_key()
RETURNS TEXT LANGUAGE plpgsql STABLE AS $$
DECLARE
  h JSONB;
  auth TEXT;
BEGIN
  h := COALESCE(current_setting('request.headers', true)::JSONB, '{}'::JSONB);
  IF h ? 'apikey' THEN
    RETURN h->>'apikey';
  END IF;
  IF h ? 'x-api-key' THEN
    RETURN h->>'x-api-key';
  END IF;
  auth := h->>'authorization';
  IF auth ILIKE 'Bearer %' THEN
    RETURN substring(auth FROM 8);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION request_key_hash()
RETURNS TEXT LANGUAGE plpgsql STABLE AS $$
DECLARE
  raw_key TEXT;
BEGIN
  raw_key := request_api_key();
  IF raw_key IS NULL OR raw_key = '' THEN
    RETURN NULL;
  END IF;
  RETURN encode(digest(raw_key, 'sha256'), 'hex');
END;
$$;

CREATE OR REPLACE FUNCTION request_owner_id()
RETURNS TEXT LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  key_hash TEXT;
  owner TEXT;
BEGIN
  key_hash := request_key_hash();
  IF key_hash IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT k.owner_id INTO owner FROM keys k WHERE k.hash = key_hash;
  RETURN owner;
END;
$$;

CREATE OR REPLACE FUNCTION request_role()
RETURNS TEXT LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  key_hash TEXT;
  role_name TEXT;
BEGIN
  key_hash := request_key_hash();
  IF key_hash IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT k.role INTO role_name FROM keys k WHERE k.hash = key_hash;
  RETURN role_name;
END;
$$;

CREATE OR REPLACE FUNCTION request_is_admin()
RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN request_role() = 'admin';
END;
$$;

-- ============================================================
-- FUNCTIONS
-- ============================================================

CREATE OR REPLACE FUNCTION search(
  q             TEXT,
  q_embedding   vector(768),
  caller        TEXT,
  n             INTEGER DEFAULT 10,
  p             TEXT DEFAULT NULL,
  s             TEXT DEFAULT NULL,
  a             FLOAT DEFAULT 0.5,
  include_pending BOOLEAN DEFAULT false,
  r             TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID, title TEXT, content TEXT, kind TEXT,
  heading TEXT, project TEXT, scope TEXT, repo TEXT,
  source_system TEXT, tool_name TEXT, score FLOAT
) LANGUAGE plpgsql AS $$
DECLARE effective_caller TEXT;
BEGIN
  effective_caller := COALESCE(request_owner_id(), caller);

  RETURN QUERY
  WITH sem AS (
    SELECT e.id, e.title, e.content, e.kind, e.heading, e.project, e.scope,
      e.repo, e.source_system, e.tool_name,
      (1 - (e.embedding <=> q_embedding))::FLOAT AS sem_score
    FROM entries e
    WHERE (p IS NULL OR e.project = p)
      AND (s IS NULL OR e.scope = s)
      AND (r IS NULL OR e.repo = r)
      AND (include_pending OR e.review = 'approved')
      AND (e.scope = 'global' OR e.scope = 'team'
           OR (e.scope = 'personal' AND e.owner_id = effective_caller))
    ORDER BY e.embedding <=> q_embedding LIMIT n * 2
  ),
  ft AS (
    SELECT e.id, e.title, e.content, e.kind, e.heading, e.project, e.scope,
      e.repo, e.source_system, e.tool_name,
      ts_rank_cd(e.fts, plainto_tsquery('english', q))::FLOAT AS fts_score
    FROM entries e
    WHERE e.fts @@ plainto_tsquery('english', q)
      AND (p IS NULL OR e.project = p)
      AND (s IS NULL OR e.scope = s)
      AND (r IS NULL OR e.repo = r)
      AND (include_pending OR e.review = 'approved')
      AND (e.scope = 'global' OR e.scope = 'team'
           OR (e.scope = 'personal' AND e.owner_id = effective_caller))
    ORDER BY fts_score DESC LIMIT n * 2
  ),
  merged AS (
    SELECT COALESCE(s.id, f.id) AS id,
      COALESCE(s.title, f.title) AS title,
      COALESCE(s.content, f.content) AS content,
      COALESCE(s.kind, f.kind) AS kind,
      COALESCE(s.heading, f.heading) AS heading,
      COALESCE(s.project, f.project) AS project,
      COALESCE(s.scope, f.scope) AS scope,
      COALESCE(s.repo, f.repo) AS repo,
      COALESCE(s.source_system, f.source_system) AS source_system,
      COALESCE(s.tool_name, f.tool_name) AS tool_name,
      (a * COALESCE(s.sem_score, 0) + (1-a) * COALESCE(f.fts_score, 0))::FLOAT AS score
    FROM sem s FULL OUTER JOIN ft f ON s.id = f.id
  )
  SELECT * FROM merged ORDER BY score DESC LIMIT n;
END;
$$;

CREATE OR REPLACE FUNCTION expand(
  target UUID, radius INTEGER DEFAULT 2
)
RETURNS TABLE (
  id UUID, chunk_index INTEGER, heading TEXT, content TEXT
) LANGUAGE plpgsql AS $$
DECLARE p UUID; idx INTEGER;
BEGIN
  SELECT e.parent_id, e.chunk_index INTO p, idx
  FROM entries e WHERE e.id = target;
  IF p IS NULL THEN p := target; idx := 0; END IF;
  RETURN QUERY
  SELECT e.id, e.chunk_index, e.heading, e.content
  FROM entries e
  WHERE e.parent_id = p
    AND e.chunk_index BETWEEN (idx - radius) AND (idx + radius)
  ORDER BY e.chunk_index;
END;
$$;

CREATE OR REPLACE FUNCTION browse(
  caller TEXT, n INTEGER DEFAULT 20,
  p TEXT DEFAULT NULL, s TEXT DEFAULT NULL, k TEXT DEFAULT NULL,
  r TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID, created_at TIMESTAMPTZ, title TEXT, content TEXT,
  kind TEXT, scope TEXT, project TEXT, repo TEXT,
  source_system TEXT, tool_name TEXT, owner_id TEXT, author TEXT, tags TEXT[]
) LANGUAGE plpgsql AS $$
DECLARE effective_caller TEXT;
BEGIN
  effective_caller := COALESCE(request_owner_id(), caller);

  RETURN QUERY
  SELECT e.id, e.created_at, e.title, left(e.content, 500),
    e.kind, e.scope, e.project, e.repo,
    e.source_system, e.tool_name, e.owner_id, e.author, e.tags
  FROM entries e
  WHERE (p IS NULL OR e.project = p)
    AND (s IS NULL OR e.scope = s)
    AND (k IS NULL OR e.kind = k)
    AND (r IS NULL OR e.repo = r)
    AND e.review != 'archived' AND e.kind != 'chunk'
    AND (e.scope = 'global' OR e.scope = 'team'
         OR (e.scope = 'personal' AND e.owner_id = effective_caller))
  ORDER BY e.created_at DESC LIMIT n;
END;
$$;

CREATE OR REPLACE FUNCTION timeline(
  n INTEGER DEFAULT 50, p TEXT DEFAULT NULL,
  k TEXT DEFAULT NULL, since TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  id UUID, ts TIMESTAMPTZ, kind TEXT, status TEXT,
  summary TEXT, project TEXT, worker TEXT, data JSONB
) LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT l.id, l.ts, l.kind, l.status, l.summary,
    l.project, l.worker, l.data
  FROM log l
  WHERE (p IS NULL OR l.project = p)
    AND (k IS NULL OR l.kind = k)
    AND (since IS NULL OR l.ts >= since)
  ORDER BY l.ts DESC LIMIT n;
END;
$$;

CREATE OR REPLACE FUNCTION sessions(
  caller TEXT,
  n INTEGER DEFAULT 50,
  p TEXT DEFAULT NULL,
  r TEXT DEFAULT NULL,
  src TEXT DEFAULT NULL
)
RETURNS TABLE (
  session_id TEXT, source_system TEXT, repo TEXT, tool_name TEXT,
  project TEXT, entry_count BIGINT, artifact_count BIGINT,
  first_seen TIMESTAMPTZ, last_seen TIMESTAMPTZ
) LANGUAGE plpgsql AS $$
DECLARE effective_caller TEXT;
BEGIN
  effective_caller := COALESCE(request_owner_id(), caller);

  RETURN QUERY
  WITH entry_sessions AS (
    SELECT e.source_session_id AS sid, e.source_system, e.repo, e.tool_name, e.project,
      count(*) AS cnt, min(e.created_at) AS first_at, max(e.created_at) AS last_at
    FROM entries e
    WHERE e.source_session_id IS NOT NULL
      AND e.owner_id = effective_caller
      AND (p IS NULL OR e.project = p)
      AND (r IS NULL OR e.repo = r)
      AND (src IS NULL OR e.source_system = src)
    GROUP BY e.source_session_id, e.source_system, e.repo, e.tool_name, e.project
  ),
  artifact_sessions AS (
    SELECT a.source_session_id AS sid, a.source_system, a.repo, a.tool_name, a.project,
      count(*) AS cnt, min(a.created_at) AS first_at, max(a.created_at) AS last_at
    FROM artifacts a
    WHERE a.source_session_id IS NOT NULL
      AND a.owner_id = effective_caller
      AND (p IS NULL OR a.project = p)
      AND (r IS NULL OR a.repo = r)
      AND (src IS NULL OR a.source_system = src)
    GROUP BY a.source_session_id, a.source_system, a.repo, a.tool_name, a.project
  ),
  combined AS (
    SELECT COALESCE(es.sid, as2.sid) AS sid,
      COALESCE(es.source_system, as2.source_system) AS source_system,
      COALESCE(es.repo, as2.repo) AS repo,
      COALESCE(es.tool_name, as2.tool_name) AS tool_name,
      COALESCE(es.project, as2.project) AS project,
      COALESCE(es.cnt, 0) AS entry_count,
      COALESCE(as2.cnt, 0) AS artifact_count,
      LEAST(es.first_at, as2.first_at) AS first_seen,
      GREATEST(es.last_at, as2.last_at) AS last_seen
    FROM entry_sessions es
    FULL OUTER JOIN artifact_sessions as2
      ON es.sid = as2.sid AND es.source_system = as2.source_system
  )
  SELECT c.sid, c.source_system, c.repo, c.tool_name, c.project,
    c.entry_count, c.artifact_count, c.first_seen, c.last_seen
  FROM combined c
  ORDER BY c.last_seen DESC NULLS LAST
  LIMIT n;
END;
$$;

CREATE OR REPLACE FUNCTION provision(
  p_id TEXT, p_name TEXT, p_role TEXT DEFAULT 'member'
) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE raw_key TEXT;
BEGIN
  IF request_key_hash() IS NOT NULL AND NOT request_is_admin() THEN
    RAISE EXCEPTION 'admin role required for provision';
  END IF;

  raw_key := encode(gen_random_bytes(32), 'hex');
  INSERT INTO keys (hash, owner_id, name, role)
  VALUES (encode(digest(raw_key, 'sha256'), 'hex'), p_id, p_name, p_role);
  RETURN raw_key;
END;
$$;

-- ============================================================
-- RLS + PRIVILEGES
-- ============================================================

ALTER TABLE entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE log ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS entries_select_policy ON entries;
CREATE POLICY entries_select_policy ON entries
  FOR SELECT
  USING (
    scope = 'global'
    OR scope = 'team'
    OR (scope = 'personal' AND owner_id = request_owner_id())
    OR (SELECT role FROM keys WHERE hash = request_key_hash()) = 'admin'
  );

DROP POLICY IF EXISTS entries_insert_policy ON entries;
CREATE POLICY entries_insert_policy ON entries
  FOR INSERT
  WITH CHECK (owner_id = request_owner_id());

DROP POLICY IF EXISTS entries_update_policy ON entries;
CREATE POLICY entries_update_policy ON entries
  FOR UPDATE
  USING (owner_id = request_owner_id())
  WITH CHECK (owner_id = request_owner_id());

DROP POLICY IF EXISTS entries_delete_policy ON entries;
CREATE POLICY entries_delete_policy ON entries
  FOR DELETE
  USING (owner_id = request_owner_id());

DROP POLICY IF EXISTS log_select_policy ON log;
CREATE POLICY log_select_policy ON log
  FOR SELECT
  USING (
    owner_id = request_owner_id()
    OR (SELECT role FROM keys WHERE hash = request_key_hash()) = 'admin'
  );

DROP POLICY IF EXISTS log_insert_policy ON log;
CREATE POLICY log_insert_policy ON log
  FOR INSERT
  WITH CHECK (owner_id = request_owner_id());

DROP POLICY IF EXISTS artifacts_select_policy ON artifacts;
CREATE POLICY artifacts_select_policy ON artifacts
  FOR SELECT
  USING (
    scope = 'global'
    OR scope = 'team'
    OR (scope = 'personal' AND owner_id = request_owner_id())
    OR (SELECT role FROM keys WHERE hash = request_key_hash()) = 'admin'
  );

DROP POLICY IF EXISTS artifacts_insert_policy ON artifacts;
CREATE POLICY artifacts_insert_policy ON artifacts
  FOR INSERT
  WITH CHECK (owner_id = request_owner_id());

DROP POLICY IF EXISTS artifacts_update_policy ON artifacts;
CREATE POLICY artifacts_update_policy ON artifacts
  FOR UPDATE
  USING (owner_id = request_owner_id())
  WITH CHECK (owner_id = request_owner_id());

DROP POLICY IF EXISTS artifacts_delete_policy ON artifacts;
CREATE POLICY artifacts_delete_policy ON artifacts
  FOR DELETE
  USING (owner_id = request_owner_id());

DROP POLICY IF EXISTS artifact_links_select_policy ON artifact_links;
CREATE POLICY artifact_links_select_policy ON artifact_links
  FOR SELECT
  USING (
    owner_id = request_owner_id()
    OR (SELECT role FROM keys WHERE hash = request_key_hash()) = 'admin'
  );

DROP POLICY IF EXISTS artifact_links_insert_policy ON artifact_links;
CREATE POLICY artifact_links_insert_policy ON artifact_links
  FOR INSERT
  WITH CHECK (owner_id = request_owner_id());

DROP POLICY IF EXISTS artifact_links_delete_policy ON artifact_links;
CREATE POLICY artifact_links_delete_policy ON artifact_links
  FOR DELETE
  USING (owner_id = request_owner_id());

DROP POLICY IF EXISTS sync_state_select_policy ON sync_state;
CREATE POLICY sync_state_select_policy ON sync_state
  FOR SELECT
  USING (
    owner_id = request_owner_id()
    OR (SELECT role FROM keys WHERE hash = request_key_hash()) = 'admin'
  );

DROP POLICY IF EXISTS sync_state_insert_policy ON sync_state;
CREATE POLICY sync_state_insert_policy ON sync_state
  FOR INSERT
  WITH CHECK (owner_id = request_owner_id());

DROP POLICY IF EXISTS sync_state_update_policy ON sync_state;
CREATE POLICY sync_state_update_policy ON sync_state
  FOR UPDATE
  USING (owner_id = request_owner_id())
  WITH CHECK (owner_id = request_owner_id());

REVOKE ALL ON TABLE entries FROM PUBLIC;
REVOKE ALL ON TABLE log FROM PUBLIC;
REVOKE ALL ON TABLE tasks FROM PUBLIC;
REVOKE ALL ON TABLE workers FROM PUBLIC;
REVOKE ALL ON TABLE keys FROM PUBLIC;
REVOKE ALL ON TABLE artifacts FROM PUBLIC;
REVOKE ALL ON TABLE artifact_links FROM PUBLIC;
REVOKE ALL ON TABLE sync_state FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON entries TO opencortex_memory_api;
GRANT SELECT, INSERT ON log TO opencortex_memory_api;
GRANT SELECT, INSERT ON keys TO opencortex_memory_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON artifacts TO opencortex_memory_api;
GRANT SELECT, INSERT, DELETE ON artifact_links TO opencortex_memory_api;
GRANT SELECT, INSERT, UPDATE ON sync_state TO opencortex_memory_api;

REVOKE ALL ON FUNCTION request_api_key() FROM PUBLIC;
REVOKE ALL ON FUNCTION request_key_hash() FROM PUBLIC;
REVOKE ALL ON FUNCTION request_owner_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION request_role() FROM PUBLIC;
REVOKE ALL ON FUNCTION request_is_admin() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION request_api_key() TO opencortex_memory_api;
GRANT EXECUTE ON FUNCTION request_key_hash() TO opencortex_memory_api;
GRANT EXECUTE ON FUNCTION request_owner_id() TO opencortex_memory_api;
GRANT EXECUTE ON FUNCTION request_role() TO opencortex_memory_api;
GRANT EXECUTE ON FUNCTION request_is_admin() TO opencortex_memory_api;

REVOKE ALL ON FUNCTION search(TEXT, vector, TEXT, INTEGER, TEXT, TEXT, FLOAT, BOOLEAN, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION expand(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION browse(TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION timeline(INTEGER, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION sessions(TEXT, INTEGER, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION provision(TEXT, TEXT, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION search(TEXT, vector, TEXT, INTEGER, TEXT, TEXT, FLOAT, BOOLEAN, TEXT) TO opencortex_memory_api;
GRANT EXECUTE ON FUNCTION expand(UUID, INTEGER) TO opencortex_memory_api;
GRANT EXECUTE ON FUNCTION browse(TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT) TO opencortex_memory_api;
GRANT EXECUTE ON FUNCTION timeline(INTEGER, TEXT, TEXT, TIMESTAMPTZ) TO opencortex_memory_api;
GRANT EXECUTE ON FUNCTION sessions(TEXT, INTEGER, TEXT, TEXT, TEXT) TO opencortex_memory_api;
GRANT EXECUTE ON FUNCTION provision(TEXT, TEXT, TEXT) TO opencortex_memory_api;
