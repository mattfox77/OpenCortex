import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/config.js';

describe('runtime config compatibility', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prefers OPENCORTEX names over legacy DIWAN names', () => {
    const config = loadConfig({
      ...requiredAuthEnv(),
      OPENCORTEX_PUBLIC_BASE_URL: 'https://runtime.example.com/',
      DIWAN_PUBLIC_BASE_URL: 'https://legacy.example.com/',
      OPENCORTEX_DATA_DIR: mkdtempSync(join(tmpdir(), 'opencortex-config-')),
      OPENCORTEX_WORKSPACE_ROOT: '/srv/opencortex/workspaces',
      OPENCORTEX_OIDC_ISSUER: 'https://accounts.google.com',
      OPENCORTEX_OIDC_CLIENT_ID: 'google-client',
      OPENCORTEX_ALLOWED_EMAIL_DOMAINS: 'example.com, contractor.example.com',
      OPENCORTEX_SUPER_ADMIN_EMAILS: 'admin@example.com',
    });

    expect(config.DIWAN_PUBLIC_BASE_URL).toBe('https://runtime.example.com/');
    expect(config.DIWAN_WORKSPACE_ROOT).toBe('/srv/opencortex/workspaces');
    expect(config.OIDC_ISSUER).toBe('https://accounts.google.com');
    expect(config.OIDC_CLIENT_ID).toBe('google-client');
    expect(config.DIWAN_ALLOWED_EMAIL_DOMAINS).toEqual([
      'example.com',
      'contractor.example.com',
    ]);
    expect(config.DIWAN_SUPER_ADMIN_EMAILS).toEqual(['admin@example.com']);
  });

  it('keeps legacy env names as a deprecated fallback', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const config = loadConfig({
      ...requiredAuthEnv(),
      DIWAN_PUBLIC_BASE_URL: 'https://legacy.example.com/',
      DIWAN_DATA_DIR: mkdtempSync(join(tmpdir(), 'diwan-config-')),
      DIWAN_ALLOWED_EMAIL_DOMAIN: 'legacy.example.com',
    });

    expect(config.DIWAN_PUBLIC_BASE_URL).toBe('https://legacy.example.com/');
    expect(config.DIWAN_ALLOWED_EMAIL_DOMAINS).toEqual(['legacy.example.com']);
    expect(warn).toHaveBeenCalledWith(
      'DIWAN_PUBLIC_BASE_URL is deprecated; use OPENCORTEX_PUBLIC_BASE_URL instead.',
    );
  });

  it('maps direct legacy Cognito env names onto generic OIDC config', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const config = loadConfig({
      OIDC_ISSUER: 'https://issuer.example.com',
      COGNITO_APP_CLIENT_ID: 'client',
      COGNITO_DOMAIN: 'https://example.auth.us-east-1.amazoncognito.com',
      DIWAN_DATA_DIR: mkdtempSync(join(tmpdir(), 'diwan-config-')),
    });

    expect(config.OIDC_ISSUER).toBe('https://issuer.example.com');
    expect(config.OIDC_CLIENT_ID).toBe('client');
    expect(config.OIDC_AUTHORIZATION_ENDPOINT).toBe(
      'https://example.auth.us-east-1.amazoncognito.com/oauth2/authorize',
    );
    expect(config.OIDC_TOKEN_ENDPOINT).toBe(
      'https://example.auth.us-east-1.amazoncognito.com/oauth2/token',
    );
    expect(warn).toHaveBeenCalledWith(
      'COGNITO_APP_CLIENT_ID is deprecated; use OIDC_CLIENT_ID instead.',
    );
  });

  it('requires an explicit OIDC issuer instead of deriving one from a Cognito pool id', () => {
    expect(() =>
      loadConfig({
        COGNITO_REGION: 'us-east-1',
        COGNITO_USER_POOL_ID: 'us-east-1_example',
        COGNITO_APP_CLIENT_ID: 'client',
        DIWAN_DATA_DIR: mkdtempSync(join(tmpdir(), 'diwan-config-')),
      }),
    ).toThrow(
      'COGNITO_USER_POOL_ID no longer derives OIDC_ISSUER; set OPENCORTEX_OIDC_ISSUER instead.',
    );
  });

  it('leaves email domains unrestricted when no allowlist is configured', () => {
    const config = loadConfig({
      ...requiredAuthEnv(),
      OPENCORTEX_DATA_DIR: mkdtempSync(join(tmpdir(), 'opencortex-config-')),
    });

    expect(config.DIWAN_ALLOWED_EMAIL_DOMAINS).toEqual([]);
  });

  it('does not bake tenant-specific Jira or Slack workspace defaults into config', () => {
    const config = loadConfig({
      ...requiredAuthEnv(),
      OPENCORTEX_DATA_DIR: mkdtempSync(join(tmpdir(), 'opencortex-config-')),
    });

    expect(config.DIWAN_JIRA_BASE_URL).toBe('');
    expect(config.SLACK_WORKSPACE_URL).toBe('');
    expect(config.SLACK_SESSION_CHANNEL_PREFIX).toBe('opencortex');
  });
});

function requiredAuthEnv(): NodeJS.ProcessEnv {
  return {
    OPENCORTEX_OIDC_ISSUER: 'https://dex.example.com',
    OPENCORTEX_OIDC_CLIENT_ID: 'client',
    OPENCORTEX_OIDC_AUTHORIZATION_ENDPOINT: 'https://dex.example.com/auth',
    OPENCORTEX_OIDC_TOKEN_ENDPOINT: 'https://dex.example.com/token',
    OPENCORTEX_OIDC_JWKS_URI: 'https://dex.example.com/keys',
  };
}
