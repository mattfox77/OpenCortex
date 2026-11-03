-- 026_task_observations.sql
-- Project dynamics on the tracker's steps (Matt 2026-11-03: package overlaps "should be part
-- of project dynamics"; he chose a table of its own over applying 020/021 to the live store).
--
-- An observation is a measured fact about a step's work, with where it came from and how sure
-- it is: the kinds and confidence levels of 021's project_dynamics_observations, keyed to
-- task_items (the steps hopworker's tracker keeps) instead of 020's agent_tasks, so 021 can
-- take these rows over when the control-plane domain ships. subject names what else the fact
-- is about (the other package of an overlap); a condition that stops holding is ended
-- (ended_at), not deleted, so the history stays. Written by hopworker from claims and host
-- runs, never by a model.
--
-- Row security follows the task tables: team-visible, writes by the owning key.
-- Idempotent like 023-025: a re-run changes nothing.

CREATE TABLE IF NOT EXISTS task_observations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project      text NOT NULL,
  task_id      uuid NOT NULL REFERENCES task_items(id) ON DELETE CASCADE,
  kind         text NOT NULL
    CHECK (kind IN ('repo_complexity', 'context_readiness', 'ci_test',
                    'runtime', 'review', 'cost', 'dependency', 'policy',
                    'human_latency', 'rework', 'forecast_falsifier', 'other')),
  subject      text CHECK (subject IS NULL OR length(subject) BETWEEN 1 AND 200),
  source       text NOT NULL CHECK (length(source) BETWEEN 1 AND 80),
  summary      text NOT NULL CHECK (length(summary) BETWEEN 1 AND 1000),
  evidence     jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(evidence) = 'object'),
  confidence   text NOT NULL DEFAULT 'observed'
    CHECK (confidence IN ('observed', 'inferred', 'estimated', 'missing')),
  observed_at  timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz CHECK (ended_at IS NULL OR ended_at >= observed_at),
  created_by   text NOT NULL,
  scope        text NOT NULL DEFAULT 'team' CHECK (scope IN ('personal','team','global')),
  owner_id     text NOT NULL DEFAULT request_owner_id(),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS task_observations_task ON task_observations (task_id, kind, observed_at DESC);
CREATE INDEX IF NOT EXISTS task_observations_open ON task_observations (project, kind) WHERE ended_at IS NULL;
-- One open observation per step, kind, source and subject.
CREATE UNIQUE INDEX IF NOT EXISTS task_observations_live
  ON task_observations (task_id, kind, source, coalesce(subject, '')) WHERE ended_at IS NULL;

ALTER TABLE task_observations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS task_observations_select_policy ON task_observations;
DROP POLICY IF EXISTS task_observations_insert_policy ON task_observations;
DROP POLICY IF EXISTS task_observations_update_policy ON task_observations;
DROP POLICY IF EXISTS task_observations_delete_policy ON task_observations;
CREATE POLICY task_observations_select_policy ON task_observations FOR SELECT USING (
  scope IN ('global','team') OR owner_id = request_owner_id()
  OR (SELECT keys.role FROM keys WHERE keys.hash = request_key_hash()) = 'admin');
CREATE POLICY task_observations_insert_policy ON task_observations FOR INSERT WITH CHECK (owner_id = request_owner_id());
CREATE POLICY task_observations_update_policy ON task_observations FOR UPDATE
  USING (owner_id = request_owner_id()) WITH CHECK (owner_id = request_owner_id());
CREATE POLICY task_observations_delete_policy ON task_observations FOR DELETE USING (owner_id = request_owner_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON task_observations TO opencortex_memory_api;
