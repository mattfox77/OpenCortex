-- 025_principals.sql
-- Who is acting (Matt 2026-11-02: "Identity is becoming a necessity"; design: hopworker
-- docs/identity.md).
--
-- People are OpenCortex identities (003) with provider 'tailscale': subject is the Tailscale
-- user id, email the login. A person acts only from a device enrolled to them
-- (person_devices: an untagged node's stable id, enrolled by a tap from an already-enrolled
-- device). principals lists everyone who can act (people, agent roles, issue threads,
-- hopworker) with what each may do; principal_bindings records which session holds a role or
-- thread now (pid + process start + boot id on fedora-2, or a Temporal workflow run).
--
-- Until hopworker's broker owns these stores, the tracker key that writes them is readable by
-- agents, so hopworker's code also refuses approve/assign/instruct to anything but a person
-- and adds people and devices only from Matt's enrolled device.
--
-- The tracker's API role reaches identities only through tailscale_identity() (writes) and the
-- tailscale_identities view (reads): other providers' rows stay out of its reach.
--
-- Idempotent like 023 and 024: a re-run changes nothing.

CREATE TABLE IF NOT EXISTS person_devices (
  provider     text NOT NULL,
  subject      text NOT NULL,
  node_id      text NOT NULL,
  hostname     text NOT NULL,
  enrolled_at  timestamptz NOT NULL DEFAULT now(),
  enrolled_by  text NOT NULL,
  revoked_at   timestamptz,
  owner_id     text NOT NULL DEFAULT request_owner_id(),
  PRIMARY KEY (provider, node_id),
  FOREIGN KEY (provider, subject) REFERENCES identities(provider, subject) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS principals (
  id              text PRIMARY KEY,
  kind            text NOT NULL,
  display         text NOT NULL,
  provider        text,
  subject         text,
  may             text[] NOT NULL DEFAULT '{}',
  definition      text,
  definition_sha  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  disabled_at     timestamptz,
  owner_id        text NOT NULL DEFAULT request_owner_id(),
  FOREIGN KEY (provider, subject) REFERENCES identities(provider, subject)
);

CREATE TABLE IF NOT EXISTS principal_bindings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id  text NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  how           text NOT NULL,
  host          text NOT NULL,
  session_id    text,
  pid           integer,
  proc_start    text,
  boot_id       text,
  workflow_id   text,
  run_id        text,
  remote        boolean NOT NULL DEFAULT false,
  bound_at      timestamptz NOT NULL DEFAULT now(),
  released_at   timestamptz,
  owner_id      text NOT NULL DEFAULT request_owner_id()
);

-- One-time enrolment codes: shown on the device being enrolled (bound to that node, which the
-- dashboard read from whois), then confirmed at the terminal (the first device) or from an
-- enrolled device. Only the code's hash is kept.
CREATE TABLE IF NOT EXISTS enrol_codes (
  code_hash    text PRIMARY KEY,
  provider     text NOT NULL,
  subject      text NOT NULL,
  node_id      text NOT NULL,
  hostname     text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  owner_id     text NOT NULL DEFAULT request_owner_id(),
  FOREIGN KEY (provider, subject) REFERENCES identities(provider, subject) ON DELETE CASCADE
);

ALTER TABLE person_devices DROP CONSTRAINT IF EXISTS person_devices_hostname_check;
ALTER TABLE person_devices ADD CONSTRAINT person_devices_hostname_check CHECK (length(hostname) BETWEEN 1 AND 200);

ALTER TABLE principals DROP CONSTRAINT IF EXISTS principals_kind_check;
ALTER TABLE principals ADD CONSTRAINT principals_kind_check CHECK (kind IN ('person','role','thread','system'));
ALTER TABLE principals DROP CONSTRAINT IF EXISTS principals_person_check;
ALTER TABLE principals ADD CONSTRAINT principals_person_check CHECK ((kind = 'person') = (subject IS NOT NULL AND provider IS NOT NULL));
ALTER TABLE principals DROP CONSTRAINT IF EXISTS principals_may_check;
ALTER TABLE principals ADD CONSTRAINT principals_may_check
  CHECK (may <@ ARRAY['comment','propose','check_in','approve','assign','be_assigned','instruct']::text[]);
-- The person-only powers, in the schema as well as in hopworker's code.
ALTER TABLE principals DROP CONSTRAINT IF EXISTS principals_person_powers_check;
ALTER TABLE principals ADD CONSTRAINT principals_person_powers_check
  CHECK (kind = 'person' OR NOT (may && ARRAY['approve','assign','instruct']::text[]));
ALTER TABLE principals DROP CONSTRAINT IF EXISTS principals_id_check;
ALTER TABLE principals ADD CONSTRAINT principals_id_check
  CHECK (id ~ '^(person|role|thread|system):.+' AND split_part(id, ':', 1) = kind AND length(id) <= 160);

ALTER TABLE principal_bindings DROP CONSTRAINT IF EXISTS principal_bindings_how_check;
ALTER TABLE principal_bindings ADD CONSTRAINT principal_bindings_how_check CHECK (how IN ('launched','claimed','resumed','matt'));
ALTER TABLE principal_bindings DROP CONSTRAINT IF EXISTS principal_bindings_key_check;
ALTER TABLE principal_bindings ADD CONSTRAINT principal_bindings_key_check
  CHECK ((pid IS NOT NULL AND proc_start IS NOT NULL AND boot_id IS NOT NULL) OR (workflow_id IS NOT NULL AND run_id IS NOT NULL) OR remote);

CREATE INDEX IF NOT EXISTS person_devices_person ON person_devices (provider, subject) WHERE revoked_at IS NULL;
-- One live binding per principal.
CREATE UNIQUE INDEX IF NOT EXISTS principal_bindings_live ON principal_bindings (principal_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS principal_bindings_session ON principal_bindings (session_id) WHERE released_at IS NULL;

ALTER TABLE person_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE principal_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrol_codes ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['person_devices','principals','principal_bindings','enrol_codes'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %1$s_select_policy ON %1$s', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$s_insert_policy ON %1$s', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$s_update_policy ON %1$s', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$s_delete_policy ON %1$s', t);
    EXECUTE format('CREATE POLICY %1$s_select_policy ON %1$s FOR SELECT USING (owner_id = request_owner_id())', t);
    EXECUTE format('CREATE POLICY %1$s_insert_policy ON %1$s FOR INSERT WITH CHECK (owner_id = request_owner_id())', t);
    EXECUTE format('CREATE POLICY %1$s_update_policy ON %1$s FOR UPDATE USING (owner_id = request_owner_id()) WITH CHECK (owner_id = request_owner_id())', t);
    EXECUTE format('CREATE POLICY %1$s_delete_policy ON %1$s FOR DELETE USING (owner_id = request_owner_id())', t);
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON person_devices, principals, principal_bindings, enrol_codes TO opencortex_memory_api;

-- Tailscale people, and nothing else of identities, for the tracker's API role.
CREATE OR REPLACE VIEW tailscale_identities AS
  SELECT subject, email, name, role, created_at, updated_at, last_login, disabled_at
  FROM identities WHERE provider = 'tailscale' AND owner_id = request_owner_id();

CREATE OR REPLACE FUNCTION tailscale_identity(p_subject text, p_email text, p_name text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF coalesce(p_subject, '') = '' OR coalesce(p_email, '') = '' THEN
    RAISE EXCEPTION 'tailscale_identity: subject and email are required';
  END IF;
  INSERT INTO identities (provider, subject, email, owner_id, name, role)
  VALUES ('tailscale', p_subject, p_email, request_owner_id(), p_name, 'member')
  ON CONFLICT (provider, subject) DO UPDATE
    SET email = EXCLUDED.email, name = EXCLUDED.name, updated_at = now(), last_login = now()
    WHERE identities.owner_id = request_owner_id();
END
$$;

REVOKE ALL ON FUNCTION tailscale_identity(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tailscale_identity(text, text, text) TO opencortex_memory_api;
GRANT SELECT ON tailscale_identities TO opencortex_memory_api;
