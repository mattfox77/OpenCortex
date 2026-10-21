-- 022_task_tracker_events.sql
-- Program target tracker (hopworker target) on the task tables.
--
-- A target is a task_cycles row (target_date = its committed baseline) with one
-- milestone task_items row that owns its events; steps are task_items in the cycle.
--
-- 1. task_events.event: allow the tracker's event kinds. burndown(), velocity() and
--    cumulative_flow() read only created/status/estimate/cycle/reopened/removed, so the
--    new kinds do not change them.
-- 2. A tracker cycle's target_date (meta.tracker set) is a committed baseline: a change is refused
--    unless the transaction sets opencortex.rebaseline_by (the tracker's re-baseline
--    path, which only Matt can run). The old date stays in meta and as a 'baseline' event.
--
-- Independent of 020/021; applied on fedora-2 before them.

DO $$
BEGIN
  ALTER TABLE task_events DROP CONSTRAINT IF EXISTS task_events_event_check;
  ALTER TABLE task_events ADD CONSTRAINT task_events_event_check
    CHECK (event IN ('created','status','estimate','cycle','reopened','removed','assigned',
                     'forecast','baseline','due','risk','alert','scope','workflow','pace','note'));
END
$$;

CREATE OR REPLACE FUNCTION task_cycles_baseline_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.target_date IS DISTINCT FROM OLD.target_date
     AND COALESCE(OLD.meta->>'tracker', '') <> ''
     AND COALESCE(current_setting('opencortex.rebaseline_by', true), '') = '' THEN
    RAISE EXCEPTION 'task_cycles.target_date is a committed baseline; re-baselining needs opencortex.rebaseline_by';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_cycles_baseline_guard ON task_cycles;
CREATE TRIGGER task_cycles_baseline_guard BEFORE UPDATE OF target_date ON task_cycles
  FOR EACH ROW EXECUTE FUNCTION task_cycles_baseline_guard();
