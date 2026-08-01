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

    expect(config.OPENCORTEX_PUBLIC_BASE_URL).toBe('https://runtime.example.com/');
    expect(config.OPENCORTEX_WORKSPACE_ROOT).toBe('/srv/opencortex/workspaces');
    expect(config.OIDC_ISSUER).toBe('https://accounts.google.com');
    expect(config.OIDC_CLIENT_ID).toBe('google-client');
    expect(config.OPENCORTEX_ALLOWED_EMAIL_DOMAINS).toEqual([
      'example.com',
      'contractor.example.com',
    ]);
    expect(config.OPENCORTEX_SUPER_ADMIN_EMAILS).toEqual(['admin@example.com']);
  });

  it('keeps legacy env names as a deprecated fallback', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const config = loadConfig({
      ...requiredAuthEnv(),
      DIWAN_PUBLIC_BASE_URL: 'https://legacy.example.com/',
      DIWAN_DATA_DIR: mkdtempSync(join(tmpdir(), 'diwan-config-')),
      DIWAN_ALLOWED_EMAIL_DOMAIN: 'legacy.example.com',
    });

    expect(config.OPENCORTEX_PUBLIC_BASE_URL).toBe('https://legacy.example.com/');
    expect(config.OPENCORTEX_ALLOWED_EMAIL_DOMAINS).toEqual(['legacy.example.com']);
    expect(warn).toHaveBeenCalledWith(
      'DIWAN_PUBLIC_BASE_URL is deprecated; use OPENCORTEX_PUBLIC_BASE_URL instead.',
    );
  });

  it('requires generic OIDC client configuration', () => {
    expect(() =>
      loadConfig({
        OIDC_ISSUER: 'https://issuer.example.com',
        OPENCORTEX_DATA_DIR: mkdtempSync(join(tmpdir(), 'opencortex-config-')),
      }),
    ).toThrow();
  });

  it('leaves email domains unrestricted when no allowlist is configured', () => {
    const config = loadConfig({
      ...requiredAuthEnv(),
      OPENCORTEX_DATA_DIR: mkdtempSync(join(tmpdir(), 'opencortex-config-')),
    });

    expect(config.OPENCORTEX_ALLOWED_EMAIL_DOMAINS).toEqual([]);
  });

  it('parses OpenCortex OIDC scopes for bundled Dex group claims', () => {
    const config = loadConfig({
      ...requiredAuthEnv(),
      OPENCORTEX_DATA_DIR: mkdtempSync(join(tmpdir(), 'opencortex-config-')),
      OPENCORTEX_OIDC_SCOPES: 'openid,email,profile,groups',
    });

    expect(config.OIDC_SCOPES).toEqual(['openid', 'email', 'profile', 'groups']);
  });

  it('does not bake tenant-specific Jira or Slack workspace defaults into config', () => {
    const config = loadConfig({
      ...requiredAuthEnv(),
      OPENCORTEX_DATA_DIR: mkdtempSync(join(tmpdir(), 'opencortex-config-')),
    });

    expect(config.OPENCORTEX_JIRA_BASE_URL).toBe('');
    expect(config.SLACK_WORKSPACE_URL).toBe('');
    expect(config.SLACK_SESSION_CHANNEL_PREFIX).toBe('opencortex');
  });

  it('keeps activity ledger opt-in and default off', () => {
    const disabled = loadConfig({
      ...requiredAuthEnv(),
      OPENCORTEX_DATA_DIR: mkdtempSync(join(tmpdir(), 'opencortex-config-')),
    });
    const enabled = loadConfig({
      ...requiredAuthEnv(),
      OPENCORTEX_DATA_DIR: mkdtempSync(join(tmpdir(), 'opencortex-config-')),
      OPENCORTEX_ACTIVITY_LEDGER_ENABLED: 'true',
    });

    expect(disabled.OPENCORTEX_ACTIVITY_LEDGER_ENABLED).toBe(false);
    expect(enabled.OPENCORTEX_ACTIVITY_LEDGER_ENABLED).toBe(true);
  });

  it('keeps provisioning workflow integration opt-in', () => {
    const local = loadConfig({
      ...requiredAuthEnv(),
      OPENCORTEX_DATA_DIR: mkdtempSync(join(tmpdir(), 'opencortex-config-')),
    });
    const workflow = loadConfig({
      ...requiredAuthEnv(),
      OPENCORTEX_DATA_DIR: mkdtempSync(join(tmpdir(), 'opencortex-config-')),
      OPENCORTEX_PROVISION_USER_MODE: 'workflow',
      OPENCORTEX_PROVISIONING_TASK_QUEUE: 'user-provisioning',
      OPENCORTEX_PROVISIONING_REQUIRED_TOOLS: 'node,git,cortex',
      TEMPORAL_ADDRESS: 'temporal.example.com:7233',
      TEMPORAL_NAMESPACE: 'opencortex',
    });

    expect(local.OPENCORTEX_PROVISION_USER_MODE).toBe('local');
    expect(local.OPENCORTEX_PROVISIONING_TASK_QUEUE).toBe('cortex-tasks');
    expect(local.OPENCORTEX_PROVISIONING_REQUIRED_TOOLS).toEqual([
      'node',
      'npm',
      'git',
      'opencode',
      'cortex',
    ]);
    expect(workflow.OPENCORTEX_PROVISION_USER_MODE).toBe('workflow');
    expect(workflow.OPENCORTEX_PROVISIONING_TASK_QUEUE).toBe('user-provisioning');
    expect(workflow.OPENCORTEX_PROVISIONING_REQUIRED_TOOLS).toEqual([
      'node',
      'git',
      'cortex',
    ]);
    expect(workflow.TEMPORAL_ADDRESS).toBe('temporal.example.com:7233');
    expect(workflow.TEMPORAL_NAMESPACE).toBe('opencortex');
  });
});

function requiredAuthEnv(): NodeJS.ProcessEnv {
  return {
    OPENCORTEX_OIDC_ISSUER: 'https://dex.example.com',
    OPENCORTEX_OIDC_CLIENT_ID: 'client',
    OPENCORTEX_OIDC_AUTHORIZATION_ENDPOINT: 'https://dex.example.com/auth',
    OPENCORTEX_OIDC_TOKEN_ENDPOINT: 'https://dex.example.com/token',
    OPENCORTEX_OIDC_JWKS_URI: 'https://dex.example.com/keys',
    OPENCORTEX_INTERNAL_TOKEN_SECRET: 'test-internal-token-secret-32-bytes',
  };
}
