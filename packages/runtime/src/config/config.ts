import { mkdirSync } from 'node:fs';
import { z } from 'zod';

function csv(defaultValue: string) {
  return z
    .string()
    .default(defaultValue)
    .transform(value =>
      value
        .split(',')
        .map(item => item.trim())
        .filter(Boolean),
    );
}

const optionalUrl = z.union([z.string().url(), z.literal('')]);

const schema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  OPENCORTEX_PUBLIC_BASE_URL: z.string().url().default('http://localhost:8080'),
  OPENCORTEX_BASE_PATH: z.string().default(''),
  OPENCORTEX_DATA_DIR: z.string().default('./data'),
  OIDC_ISSUER: z.string().url(),
  OIDC_CLIENT_ID: z.string().min(1),
  OIDC_CLIENT_SECRET: z.string().default(''),
  OIDC_REDIRECT_PATH: z.string().default('/auth/callback'),
  OIDC_REQUIRED_GROUPS: csv(''),
  OIDC_GROUPS_CLAIM: z.string().default('groups'),
  OIDC_SCOPES: csv('openid,email,profile'),
  OIDC_AUTHORIZATION_ENDPOINT: z.string().default(''),
  OIDC_TOKEN_ENDPOINT: z.string().default(''),
  OIDC_JWKS_URI: z.string().default(''),
  OIDC_END_SESSION_ENDPOINT: z.string().default(''),
  COGNITO_REGION: z.string().default('us-east-1'),
  COGNITO_USER_POOL_ID: z.string().default(''),
  COGNITO_APP_CLIENT_ID: z.string().default(''),
  COGNITO_DOMAIN: z.string().default(''),
  COGNITO_REDIRECT_PATH: z.string().default('/auth/callback'),
  COGNITO_REQUIRED_GROUPS: csv(''),
  DIWAN_ALLOWED_EMAIL_DOMAIN: z.string().default(''),
  OPENCORTEX_ALLOWED_EMAIL_DOMAINS: csv(''),
  OPENCORTEX_SUPER_ADMIN_EMAILS: csv(''),
  OPENCORTEX_LINUX_USER_PREFIX: z.string().default(''),
  OPENCORTEX_WORKSPACE_ROOT: z.string().default('/srv/opencortex/workspaces'),
  OPENCORTEX_EXEC_MODE: z.enum(['dry-run', 'sudo']).default('dry-run'),
  OPENCORTEX_WORKBENCH_PORT_BASE: z.coerce.number().int().positive().default(4100),
  OPENCORTEX_WORKBENCH_BIN: z.string().default('/usr/local/bin/opencode'),
  OPENCORTEX_PROVISION_USER_SCRIPT: z
    .string()
    .default('/opt/opencortex/scripts/provision-opencortex-user.sh'),
  OPENCORTEX_JIRA_BASE_URL: optionalUrl.default(''),
  SLACK_BOT_TOKEN: z.string().default(''),
  SLACK_API_BASE_URL: z.string().url().default('https://slack.com/api'),
  SLACK_WORKSPACE_URL: optionalUrl.default(''),
  SLACK_SESSION_CHANNEL_PREFIX: z.string().default('opencortex'),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env = process.env): AppConfig {
  const parsed = schema.parse(normalizeEnv(env));
  mkdirSync(parsed.OPENCORTEX_DATA_DIR, { recursive: true });
  return parsed;
}

function normalizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const normalized = { ...env };
  applyAlias(normalized, 'OPENCORTEX_PUBLIC_BASE_URL', 'DIWAN_PUBLIC_BASE_URL');
  applyAlias(normalized, 'OPENCORTEX_BASE_PATH', 'DIWAN_BASE_PATH');
  applyAlias(normalized, 'OPENCORTEX_DATA_DIR', 'DIWAN_DATA_DIR');
  applyAlias(normalized, 'OPENCORTEX_WORKSPACE_ROOT', 'DIWAN_WORKSPACE_ROOT');
  applyAlias(normalized, 'OPENCORTEX_ALLOWED_EMAIL_DOMAINS', 'DIWAN_ALLOWED_EMAIL_DOMAINS');
  applyAlias(normalized, 'OPENCORTEX_SUPER_ADMIN_EMAILS', 'DIWAN_SUPER_ADMIN_EMAILS');
  applyAlias(normalized, 'OPENCORTEX_LINUX_USER_PREFIX', 'DIWAN_LINUX_USER_PREFIX');
  applyAlias(normalized, 'OPENCORTEX_EXEC_MODE', 'DIWAN_EXEC_MODE');
  applyAlias(normalized, 'OPENCORTEX_WORKBENCH_PORT_BASE', 'DIWAN_OPENCODE_PORT_BASE');
  applyAlias(normalized, 'OPENCORTEX_WORKBENCH_BIN', 'DIWAN_OPENCODE_BIN');
  applyAlias(normalized, 'OPENCORTEX_PROVISION_USER_SCRIPT', 'DIWAN_PROVISION_USER_SCRIPT');
  applyAlias(normalized, 'OPENCORTEX_JIRA_BASE_URL', 'DIWAN_JIRA_BASE_URL');
  applyInputAlias(normalized, 'OPENCORTEX_OIDC_ISSUER', 'OIDC_ISSUER');
  applyInputAlias(normalized, 'OPENCORTEX_OIDC_CLIENT_ID', 'OIDC_CLIENT_ID');
  applyInputAlias(normalized, 'OPENCORTEX_OIDC_CLIENT_SECRET', 'OIDC_CLIENT_SECRET');
  applyInputAlias(normalized, 'OPENCORTEX_OIDC_REDIRECT_PATH', 'OIDC_REDIRECT_PATH');
  applyInputAlias(normalized, 'OPENCORTEX_OIDC_GROUPS_CLAIM', 'OIDC_GROUPS_CLAIM');
  applyInputAlias(normalized, 'OPENCORTEX_OIDC_SCOPES', 'OIDC_SCOPES');
  applyInputAlias(normalized, 'OPENCORTEX_OIDC_AUTHORIZATION_ENDPOINT', 'OIDC_AUTHORIZATION_ENDPOINT');
  applyInputAlias(normalized, 'OPENCORTEX_OIDC_TOKEN_ENDPOINT', 'OIDC_TOKEN_ENDPOINT');
  applyInputAlias(normalized, 'OPENCORTEX_OIDC_JWKS_URI', 'OIDC_JWKS_URI');
  applyInputAlias(normalized, 'OPENCORTEX_OIDC_END_SESSION_ENDPOINT', 'OIDC_END_SESSION_ENDPOINT');
  applyInputAlias(normalized, 'OPENCORTEX_REQUIRED_GROUPS', 'OIDC_REQUIRED_GROUPS');
  applyAlias(normalized, 'OIDC_CLIENT_ID', 'COGNITO_APP_CLIENT_ID');
  applyAlias(normalized, 'OIDC_REDIRECT_PATH', 'COGNITO_REDIRECT_PATH');
  applyAlias(normalized, 'OIDC_REQUIRED_GROUPS', 'COGNITO_REQUIRED_GROUPS');

  if (!normalized.OIDC_ISSUER && normalized.COGNITO_USER_POOL_ID) {
    throw new Error(
      'COGNITO_USER_POOL_ID no longer derives OIDC_ISSUER; set OPENCORTEX_OIDC_ISSUER instead.',
    );
  }
  if (normalized.COGNITO_DOMAIN) {
    if (!normalized.OIDC_AUTHORIZATION_ENDPOINT) {
      normalized.OIDC_AUTHORIZATION_ENDPOINT = `${normalized.COGNITO_DOMAIN}/oauth2/authorize`;
    }
    if (!normalized.OIDC_TOKEN_ENDPOINT) {
      normalized.OIDC_TOKEN_ENDPOINT = `${normalized.COGNITO_DOMAIN}/oauth2/token`;
    }
    if (!normalized.OIDC_END_SESSION_ENDPOINT) {
      normalized.OIDC_END_SESSION_ENDPOINT = `${normalized.COGNITO_DOMAIN}/logout`;
    }
    console.warn('COGNITO_DOMAIN is deprecated; use OIDC issuer metadata or OIDC_* endpoints instead.');
  }

  if (!normalized.OPENCORTEX_ALLOWED_EMAIL_DOMAINS && normalized.DIWAN_ALLOWED_EMAIL_DOMAIN) {
    normalized.OPENCORTEX_ALLOWED_EMAIL_DOMAINS = normalized.DIWAN_ALLOWED_EMAIL_DOMAIN;
  }

  return normalized;
}

function applyAlias(env: NodeJS.ProcessEnv, preferred: string, legacy: string): void {
  if (env[preferred]) {
    return;
  }
  if (env[legacy]) {
    env[preferred] = env[legacy];
    console.warn(`${legacy} is deprecated; use ${preferred} instead.`);
  }
}

function applyInputAlias(env: NodeJS.ProcessEnv, preferred: string, target: string): void {
  if (env[preferred]) {
    env[target] = env[preferred];
  }
}
