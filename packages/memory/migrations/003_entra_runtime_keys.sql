-- Brain Trust Entra-gated provisioning support.
-- Safe to run repeatedly on existing deployments.

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
