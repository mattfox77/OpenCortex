-- ============================================================
-- SERVICE-ACCOUNT KEY ISSUANCE ONLY
-- ============================================================
-- Phase 4 moves human auth to OIDC/internal tokens. Existing human keys remain
-- valid during the deprecation window, but new key issuance is restricted to
-- service-account keys (role = agent).
-- ============================================================

CREATE OR REPLACE FUNCTION provision(
  p_id TEXT, p_name TEXT, p_role TEXT DEFAULT 'agent'
) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE raw_key TEXT;
BEGIN
  IF p_role IS DISTINCT FROM 'agent' THEN
    RAISE EXCEPTION 'human key issuance is disabled; use OIDC login for users and role=agent for service accounts';
  END IF;

  IF request_key_hash() IS NOT NULL AND NOT request_is_admin() THEN
    RAISE EXCEPTION 'admin role required for provision';
  END IF;

  raw_key := encode(gen_random_bytes(32), 'hex');
  INSERT INTO keys (hash, owner_id, name, role)
  VALUES (encode(digest(raw_key, 'sha256'), 'hex'), p_id, p_name, p_role);
  RETURN raw_key;
END;
$$;

COMMENT ON FUNCTION provision(TEXT, TEXT, TEXT)
  IS 'Issue service-account memory keys only. Human key issuance is disabled in Phase 4; existing human keys remain valid during the deprecation window.';
