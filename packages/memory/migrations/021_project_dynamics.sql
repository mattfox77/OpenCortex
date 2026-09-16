-- ============================================================
-- PROJECT DYNAMICS: evidence-backed planning and forecasting
-- ============================================================
-- Adds defensible project measurement records for agentic work. This does not
-- remove legacy task estimate/burndown compatibility; it provides the new
-- authority for scope, risk, and timeframe forecasts.
-- ============================================================

CREATE TABLE IF NOT EXISTS project_dynamics_observations (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id        TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL
    CHECK (kind IN ('repo_complexity', 'context_readiness', 'ci_test',
                    'runtime', 'review', 'cost', 'dependency', 'policy',
                    'human_latency', 'rework', 'forecast_falsifier', 'other')),
  source         TEXT NOT NULL,
  summary        TEXT NOT NULL,
  evidence       JSONB NOT NULL DEFAULT '{}',
  confidence     TEXT NOT NULL DEFAULT 'observed'
    CHECK (confidence IN ('observed', 'inferred', 'estimated', 'missing')),
  observed_at    TIMESTAMPTZ DEFAULT now() NOT NULL,
  created_by     TEXT NOT NULL,
  created_at     TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS project_dynamics_forecasts (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id            TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  status             TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'superseded', 'withdrawn')),
  forecast_min_hours NUMERIC,
  forecast_max_hours NUMERIC,
  confidence         NUMERIC NOT NULL DEFAULT 0
    CHECK (confidence >= 0 AND confidence <= 1),
  basis_sample_size  INTEGER NOT NULL DEFAULT 0
    CHECK (basis_sample_size >= 0),
  basis              JSONB NOT NULL DEFAULT '{}',
  assumptions        JSONB NOT NULL DEFAULT '[]',
  falsifiers         JSONB NOT NULL DEFAULT '[]',
  risks              JSONB NOT NULL DEFAULT '[]',
  scenarios          JSONB NOT NULL DEFAULT '[]',
  unsupported_guess  BOOLEAN NOT NULL DEFAULT false,
  source             TEXT NOT NULL DEFAULT 'opencortex',
  metadata           JSONB NOT NULL DEFAULT '{}',
  created_by         TEXT NOT NULL,
  created_at         TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at         TIMESTAMPTZ DEFAULT now() NOT NULL,
  superseded_at      TIMESTAMPTZ,
  CHECK (
    unsupported_guess
    OR basis_sample_size > 0
    OR jsonb_typeof(basis) = 'object' AND basis <> '{}'::jsonb
  ),
  CHECK (
    forecast_min_hours IS NULL
    OR forecast_max_hours IS NULL
    OR forecast_min_hours <= forecast_max_hours
  )
);

CREATE INDEX IF NOT EXISTS idx_project_dynamics_observations_task
  ON project_dynamics_observations(tenant_id, task_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_dynamics_observations_kind
  ON project_dynamics_observations(tenant_id, kind, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_dynamics_forecasts_task
  ON project_dynamics_forecasts(tenant_id, task_id, status, updated_at DESC);

DROP TRIGGER IF EXISTS project_dynamics_forecasts_ts ON project_dynamics_forecasts;
CREATE TRIGGER project_dynamics_forecasts_ts BEFORE UPDATE ON project_dynamics_forecasts
  FOR EACH ROW EXECUTE FUNCTION update_ts();

ALTER TABLE project_dynamics_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_dynamics_forecasts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS project_dynamics_observations_admin_policy
  ON project_dynamics_observations;
CREATE POLICY project_dynamics_observations_admin_policy
  ON project_dynamics_observations
  FOR ALL USING (request_is_admin()) WITH CHECK (request_is_admin());

DROP POLICY IF EXISTS project_dynamics_forecasts_admin_policy
  ON project_dynamics_forecasts;
CREATE POLICY project_dynamics_forecasts_admin_policy
  ON project_dynamics_forecasts
  FOR ALL USING (request_is_admin()) WITH CHECK (request_is_admin());

CREATE OR REPLACE VIEW project_dynamics_task_summary AS
SELECT
  t.tenant_id,
  t.id AS task_id,
  t.title,
  t.status AS task_status,
  count(o.id)::integer AS observation_count,
  max(o.observed_at) AS last_observed_at,
  f.id AS current_forecast_id,
  f.forecast_min_hours,
  f.forecast_max_hours,
  f.confidence,
  f.basis_sample_size,
  f.unsupported_guess,
  f.updated_at AS forecast_updated_at
FROM agent_tasks t
LEFT JOIN project_dynamics_observations o
  ON o.tenant_id = t.tenant_id AND o.task_id = t.id
LEFT JOIN LATERAL (
  SELECT pf.*
  FROM project_dynamics_forecasts pf
  WHERE pf.tenant_id = t.tenant_id
    AND pf.task_id = t.id
    AND pf.status = 'active'
  ORDER BY pf.updated_at DESC
  LIMIT 1
) f ON true
GROUP BY
  t.tenant_id, t.id, t.title, t.status, f.id, f.forecast_min_hours,
  f.forecast_max_hours, f.confidence, f.basis_sample_size,
  f.unsupported_guess, f.updated_at;

CREATE OR REPLACE FUNCTION project_dynamics_record_observation(
  p_id          TEXT,
  p_tenant_id   TEXT,
  p_task_id     TEXT,
  p_kind        TEXT,
  p_source      TEXT,
  p_summary     TEXT,
  p_evidence    JSONB DEFAULT '{}',
  p_confidence  TEXT DEFAULT 'observed',
  p_observed_at TIMESTAMPTZ DEFAULT NULL,
  p_created_by  TEXT DEFAULT NULL
) RETURNS project_dynamics_observations LANGUAGE plpgsql AS $$
DECLARE
  row project_dynamics_observations;
BEGIN
  IF NOT request_is_admin() THEN RAISE EXCEPTION 'admin required'; END IF;

  INSERT INTO project_dynamics_observations(
    id, tenant_id, task_id, kind, source, summary, evidence, confidence,
    observed_at, created_by
  )
  VALUES (
    p_id, p_tenant_id, p_task_id, p_kind, p_source, p_summary,
    COALESCE(p_evidence, '{}'::jsonb), p_confidence,
    COALESCE(p_observed_at, now()), COALESCE(p_created_by, request_owner_id(), 'system')
  )
  RETURNING * INTO row;
  RETURN row;
END;
$$;

CREATE OR REPLACE FUNCTION project_dynamics_publish_forecast(
  p_id                 TEXT,
  p_tenant_id          TEXT,
  p_task_id            TEXT,
  p_forecast_min_hours NUMERIC,
  p_forecast_max_hours NUMERIC,
  p_confidence         NUMERIC,
  p_basis_sample_size  INTEGER,
  p_basis              JSONB DEFAULT '{}',
  p_assumptions        JSONB DEFAULT '[]',
  p_falsifiers         JSONB DEFAULT '[]',
  p_risks              JSONB DEFAULT '[]',
  p_scenarios          JSONB DEFAULT '[]',
  p_unsupported_guess  BOOLEAN DEFAULT false,
  p_source             TEXT DEFAULT 'opencortex',
  p_metadata           JSONB DEFAULT '{}',
  p_created_by         TEXT DEFAULT NULL
) RETURNS project_dynamics_forecasts LANGUAGE plpgsql AS $$
DECLARE
  row project_dynamics_forecasts;
BEGIN
  IF NOT request_is_admin() THEN RAISE EXCEPTION 'admin required'; END IF;

  UPDATE project_dynamics_forecasts
     SET status = 'superseded',
         superseded_at = now()
   WHERE tenant_id = p_tenant_id
     AND task_id = p_task_id
     AND status = 'active';

  INSERT INTO project_dynamics_forecasts(
    id, tenant_id, task_id, forecast_min_hours, forecast_max_hours,
    confidence, basis_sample_size, basis, assumptions, falsifiers, risks,
    scenarios, unsupported_guess, source, metadata, created_by
  )
  VALUES (
    p_id, p_tenant_id, p_task_id, p_forecast_min_hours, p_forecast_max_hours,
    p_confidence, p_basis_sample_size, COALESCE(p_basis, '{}'::jsonb),
    COALESCE(p_assumptions, '[]'::jsonb), COALESCE(p_falsifiers, '[]'::jsonb),
    COALESCE(p_risks, '[]'::jsonb), COALESCE(p_scenarios, '[]'::jsonb),
    COALESCE(p_unsupported_guess, false), p_source,
    COALESCE(p_metadata, '{}'::jsonb), COALESCE(p_created_by, request_owner_id(), 'system')
  )
  RETURNING * INTO row;
  RETURN row;
END;
$$;

REVOKE ALL ON TABLE
  project_dynamics_observations,
  project_dynamics_forecasts
FROM PUBLIC;
REVOKE ALL ON TABLE project_dynamics_task_summary FROM PUBLIC;
REVOKE ALL ON FUNCTION project_dynamics_record_observation(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TIMESTAMPTZ, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION project_dynamics_publish_forecast(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, INTEGER, JSONB, JSONB, JSONB,
  JSONB, JSONB, BOOLEAN, TEXT, JSONB, TEXT
) FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  project_dynamics_observations,
  project_dynamics_forecasts
TO opencortex_memory_api;
GRANT SELECT ON TABLE project_dynamics_task_summary TO opencortex_memory_api;
GRANT EXECUTE ON FUNCTION project_dynamics_record_observation(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TIMESTAMPTZ, TEXT
) TO opencortex_memory_api;
GRANT EXECUTE ON FUNCTION project_dynamics_publish_forecast(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, INTEGER, JSONB, JSONB, JSONB,
  JSONB, JSONB, BOOLEAN, TEXT, JSONB, TEXT
) TO opencortex_memory_api;
