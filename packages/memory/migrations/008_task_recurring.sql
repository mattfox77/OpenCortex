-- ============================================================
-- MIGRATION: F1 recurring tasks + F2 due-date reminders (v1.10.0)
-- ============================================================
-- Adds recurrence (spawn a fresh copy on a schedule) and reminder
-- identification (which open, due-soon tasks need a nudge). Delivery of
-- reminders is done by the dashboard temporal-worker (voice notify + brain
-- log); this migration only spawns recurrences and IDENTIFIES + stamps
-- reminders so the worker can deliver them idempotently.
--
-- Safe to run repeatedly. Run AFTER 04/05/06/07. Does NOT touch Temporal `tasks`.
-- ============================================================

-- ------------------------------------------------------------
-- 1. columns
-- ------------------------------------------------------------
DO $$
BEGIN
  -- recurrence rule
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='task_items' AND column_name='recurrence') THEN
    ALTER TABLE task_items ADD COLUMN recurrence TEXT
      CHECK (recurrence IS NULL OR recurrence IN ('daily','weekly','monthly'));
  END IF;
END $$;
ALTER TABLE task_items ADD COLUMN IF NOT EXISTS recur_anchor DATE;        -- next spawn date
ALTER TABLE task_items ADD COLUMN IF NOT EXISTS recur_spawned_for DATE;   -- last anchor already spawned (idempotency)
ALTER TABLE task_items ADD COLUMN IF NOT EXISTS remind_offset_days INT NOT NULL DEFAULT 1;
ALTER TABLE task_items ADD COLUMN IF NOT EXISTS last_reminded_at DATE;

CREATE INDEX IF NOT EXISTS idx_task_items_recur ON task_items(recurrence, recur_anchor)
  WHERE recurrence IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_items_remind ON task_items(due_date)
  WHERE due_date IS NOT NULL;

-- ------------------------------------------------------------
-- 2. next_anchor: given a rule and a date, the next occurrence date.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION next_anchor(p_rule TEXT, p_from DATE)
RETURNS DATE LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_rule
    WHEN 'daily'   THEN p_from + 1
    WHEN 'weekly'  THEN p_from + 7
    WHEN 'monthly' THEN (p_from + interval '1 month')::date
    ELSE NULL END;
$$;

-- ------------------------------------------------------------
-- 3. spawn_recurrences: for every recurring task whose anchor has arrived and
--    hasn't been spawned yet, create a fresh todo copy dated to the next anchor
--    and advance the template's anchor. Idempotent via recur_spawned_for.
--    Returns count spawned. Runs for ALL owners (called by the system worker).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION spawn_recurrences()
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
  r       RECORD;
  spawned INT := 0;
  nk      TEXT;
BEGIN
  FOR r IN
    SELECT * FROM task_items
    WHERE recurrence IS NOT NULL
      AND recur_anchor IS NOT NULL
      AND recur_anchor <= current_date
      AND (recur_spawned_for IS NULL OR recur_spawned_for < recur_anchor)
  LOOP
    nk := COALESCE((SELECT max(order_key) FROM task_items
                    WHERE owner_id = r.owner_id AND workstream = r.workstream), '') || 'n';
    INSERT INTO task_items(owner_id, author, scope, title, body, priority,
                           due_date, workstream, order_key, project, estimate,
                           cycle_id, remind_offset_days)
    VALUES (r.owner_id, r.author, r.scope, r.title, r.body, r.priority,
            r.recur_anchor, r.workstream, nk, r.project, r.estimate,
            r.cycle_id, r.remind_offset_days)
    RETURNING id INTO nk;  -- reuse nk to hold the new id
    INSERT INTO task_events(task_id, cycle_id, owner_id, event, to_status, to_points)
    VALUES (nk::uuid, r.cycle_id, r.owner_id, 'created', 'todo', r.estimate);
    -- advance the template
    UPDATE task_items
      SET recur_spawned_for = recur_anchor,
          recur_anchor = next_anchor(recurrence, recur_anchor)
      WHERE id = r.id;
    spawned := spawned + 1;
  END LOOP;
  RETURN spawned;
END;
$$;

-- ------------------------------------------------------------
-- 4. due_reminders: open tasks within their reminder window not yet reminded
--    today. If p_stamp, mark last_reminded_at = today (so the worker won't
--    re-notify). Returns the reminder list as JSON for the worker to deliver.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION due_reminders(p_stamp BOOLEAN DEFAULT false)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  result JSONB;
BEGIN
  SELECT coalesce(jsonb_agg(jsonb_build_object(
            'id', id, 'owner_id', owner_id, 'title', title,
            'due_date', due_date, 'priority', priority, 'workstream', workstream,
            'overdue', (due_date < current_date))), '[]'::jsonb)
    INTO result
  FROM task_items
  WHERE status IN ('todo','doing','blocked')
    AND due_date IS NOT NULL
    AND due_date - current_date <= remind_offset_days
    AND (last_reminded_at IS NULL OR last_reminded_at < current_date);

  IF p_stamp THEN
    UPDATE task_items SET last_reminded_at = current_date
    WHERE status IN ('todo','doing','blocked')
      AND due_date IS NOT NULL
      AND due_date - current_date <= remind_offset_days
      AND (last_reminded_at IS NULL OR last_reminded_at < current_date);
  END IF;

  RETURN result;
END;
$$;

-- ------------------------------------------------------------
-- 5. task_maintenance: the once-daily system tick — spawn recurrences and
--    return reminders (stamping them). Called by the worker.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION task_maintenance()
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE n INT; rem JSONB;
BEGIN
  n   := spawn_recurrences();
  rem := due_reminders(true);
  RETURN jsonb_build_object('spawned', n, 'reminders', rem);
END;
$$;

-- ------------------------------------------------------------
-- 6. grants
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION next_anchor(TEXT,DATE) FROM PUBLIC;
REVOKE ALL ON FUNCTION spawn_recurrences() FROM PUBLIC;
REVOKE ALL ON FUNCTION due_reminders(BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION task_maintenance() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION next_anchor(TEXT,DATE) TO opencortex_memory_api;
GRANT EXECUTE ON FUNCTION spawn_recurrences() TO opencortex_memory_api;
GRANT EXECUTE ON FUNCTION due_reminders(BOOLEAN) TO opencortex_memory_api;
GRANT EXECUTE ON FUNCTION task_maintenance() TO opencortex_memory_api;
