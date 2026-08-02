-- ============================================================
-- DISABLE LEGACY HUMAN BRAIN KEYS
-- ============================================================
-- Phase 6 ends the deprecation window from 017. The legacy key path remains
-- available only for service-account keys (role = agent). Human access must
-- use OIDC/internal tokens through the OpenCortex API.
-- ============================================================

CREATE OR REPLACE FUNCTION request_key_hash()
RETURNS TEXT LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  raw_key TEXT;
  key_hash TEXT;
  role_name TEXT;
BEGIN
  raw_key := request_api_key();
  IF raw_key IS NULL OR raw_key = '' THEN
    RETURN NULL;
  END IF;

  key_hash := encode(digest(raw_key, 'sha256'), 'hex');
  SELECT k.role INTO role_name FROM keys k WHERE k.hash = key_hash;
  IF role_name IN ('admin', 'member') THEN
    RAISE EXCEPTION 'legacy human memory keys are disabled; use OpenCortex OIDC/internal tokens for users';
  END IF;
  RETURN key_hash;
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

COMMENT ON FUNCTION request_key_hash()
  IS 'Resolve a service-account memory key hash. Legacy admin/member Brain keys are disabled in Phase 6.';
COMMENT ON FUNCTION request_owner_id()
  IS 'Resolve service-account key owner. Legacy human Brain keys must use OpenCortex OIDC/internal tokens.';
COMMENT ON FUNCTION request_role()
  IS 'Resolve service-account key role. Legacy human Brain keys must use OpenCortex OIDC/internal tokens.';

REVOKE ALL ON FUNCTION request_key_hash() FROM PUBLIC;
REVOKE ALL ON FUNCTION request_owner_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION request_role() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION request_key_hash() TO opencortex_memory_api;
GRANT EXECUTE ON FUNCTION request_owner_id() TO opencortex_memory_api;
GRANT EXECUTE ON FUNCTION request_role() TO opencortex_memory_api;
