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
      OPENCORTEX_ALLOWED_EMAIL_DOMAINS: 'example.com, contractor.example.com',
      OPENCORTEX_SUPER_ADMIN_EMAILS: 'admin@example.com',
    });

    expect(config.DIWAN_PUBLIC_BASE_URL).toBe('https://runtime.example.com/');
    expect(config.DIWAN_WORKSPACE_ROOT).toBe('/srv/opencortex/workspaces');
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

  it('leaves email domains unrestricted when no allowlist is configured', () => {
    const config = loadConfig({
      ...requiredAuthEnv(),
      OPENCORTEX_DATA_DIR: mkdtempSync(join(tmpdir(), 'opencortex-config-')),
    });

    expect(config.DIWAN_ALLOWED_EMAIL_DOMAINS).toEqual([]);
  });
});

function requiredAuthEnv(): NodeJS.ProcessEnv {
  return {
    COGNITO_USER_POOL_ID: 'us-east-1_example',
    COGNITO_APP_CLIENT_ID: 'client',
    COGNITO_DOMAIN: 'https://oidc.example.com',
  };
}
