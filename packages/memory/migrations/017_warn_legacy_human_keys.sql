-- ============================================================
-- LEGACY HUMAN KEY DEPRECATION WARNINGS
-- ============================================================
-- Existing admin/member keys remain valid through the Phase 6 deprecation
-- window, but any use emits a warning. Service-account keys (role = agent)
-- remain first-class and do not warn.
-- ============================================================

CREATE OR REPLACE FUNCTION request_owner_id()
RETURNS TEXT LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  key_hash TEXT;
  owner TEXT;
  role_name TEXT;
BEGIN
  key_hash := request_key_hash();
  IF key_hash IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT k.owner_id, k.role INTO owner, role_name FROM keys k WHERE k.hash = key_hash;
  IF role_name IN ('admin', 'member') THEN
    RAISE WARNING 'legacy human memory key role "%" is deprecated; use OpenCortex OIDC/internal tokens for users', role_name;
  END IF;
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
  IF role_name IN ('admin', 'member') THEN
    RAISE WARNING 'legacy human memory key role "%" is deprecated; use OpenCortex OIDC/internal tokens for users', role_name;
  END IF;
  RETURN role_name;
END;
$$;

COMMENT ON FUNCTION request_owner_id()
  IS 'Resolve legacy key owner. Emits a Phase 4 deprecation warning for admin/member human keys.';
COMMENT ON FUNCTION request_role()
  IS 'Resolve legacy key role. Emits a Phase 4 deprecation warning for admin/member human keys.';
