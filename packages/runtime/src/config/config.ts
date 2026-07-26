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

const schema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  DIWAN_PUBLIC_BASE_URL: z.string().url().default('http://localhost:8080'),
  DIWAN_BASE_PATH: z.string().default(''),
  DIWAN_DATA_DIR: z.string().default('./data'),
  COGNITO_REGION: z.string().default('us-east-1'),
  COGNITO_USER_POOL_ID: z.string().min(1),
  COGNITO_APP_CLIENT_ID: z.string().min(1),
  COGNITO_DOMAIN: z.string().url(),
  COGNITO_REDIRECT_PATH: z.string().default('/auth/callback'),
  COGNITO_REQUIRED_GROUPS: csv('TeamChatUsers,OpenCodeUsers'),
  DIWAN_ALLOWED_EMAIL_DOMAIN: z.string().default(''),
  DIWAN_ALLOWED_EMAIL_DOMAINS: csv(''),
  DIWAN_SUPER_ADMIN_EMAILS: csv(''),
  DIWAN_LINUX_USER_PREFIX: z.string().default(''),
  DIWAN_WORKSPACE_ROOT: z.string().default('/srv/diwan/workspaces'),
  DIWAN_EXEC_MODE: z.enum(['dry-run', 'sudo', 'aws-ssm']).default('dry-run'),
  DIWAN_OPENCODE_PORT_BASE: z.coerce.number().int().positive().default(4100),
  DIWAN_OPENCODE_BIN: z.string().default('/usr/local/bin/opencode'),
  DIWAN_PROVISION_USER_SCRIPT: z
    .string()
    .default('/opt/diwan/scripts/provision-diwan-user.sh'),
  DIWAN_AWS_REGION: z.string().default('us-east-1'),
  DIWAN_SSM_TARGET_INSTANCE_ID: z.string().default(''),
  DIWAN_SSM_LOCAL_PORT_BASE: z.coerce.number().int().positive().default(5100),
  DIWAN_AWS_BIN: z.string().default('/usr/local/bin/aws'),
  DIWAN_JIRA_BASE_URL: z
    .string()
    .url()
    .default('https://dsnsoft-dev.atlassian.net'),
  SLACK_BOT_TOKEN: z.string().default(''),
  SLACK_API_BASE_URL: z.string().url().default('https://slack.com/api'),
  SLACK_WORKSPACE_URL: z.string().url().default('https://dsnsoft.slack.com'),
  SLACK_SESSION_CHANNEL_PREFIX: z.string().default('diwan'),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env = process.env): AppConfig {
  const parsed = schema.parse(normalizeEnv(env));
  mkdirSync(parsed.DIWAN_DATA_DIR, { recursive: true });
  return parsed;
}

export function cognitoIssuer(config: AppConfig): string {
  return `https://cognito-idp.${config.COGNITO_REGION}.amazonaws.com/${config.COGNITO_USER_POOL_ID}`;
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
  applyAlias(normalized, 'OPENCORTEX_AWS_REGION', 'DIWAN_AWS_REGION');
  applyAlias(normalized, 'OPENCORTEX_SSM_TARGET_INSTANCE_ID', 'DIWAN_SSM_TARGET_INSTANCE_ID');
  applyAlias(normalized, 'OPENCORTEX_SSM_LOCAL_PORT_BASE', 'DIWAN_SSM_LOCAL_PORT_BASE');
  applyAlias(normalized, 'OPENCORTEX_AWS_BIN', 'DIWAN_AWS_BIN');
  applyAlias(normalized, 'OPENCORTEX_JIRA_BASE_URL', 'DIWAN_JIRA_BASE_URL');
  applyAlias(normalized, 'OPENCORTEX_OIDC_REGION', 'COGNITO_REGION');
  applyAlias(normalized, 'OPENCORTEX_OIDC_USER_POOL_ID', 'COGNITO_USER_POOL_ID');
  applyAlias(normalized, 'OPENCORTEX_OIDC_CLIENT_ID', 'COGNITO_APP_CLIENT_ID');
  applyAlias(normalized, 'OPENCORTEX_OIDC_DOMAIN', 'COGNITO_DOMAIN');
  applyAlias(normalized, 'OPENCORTEX_OIDC_REDIRECT_PATH', 'COGNITO_REDIRECT_PATH');
  applyAlias(normalized, 'OPENCORTEX_REQUIRED_GROUPS', 'COGNITO_REQUIRED_GROUPS');

  if (!normalized.DIWAN_ALLOWED_EMAIL_DOMAINS && normalized.DIWAN_ALLOWED_EMAIL_DOMAIN) {
    normalized.DIWAN_ALLOWED_EMAIL_DOMAINS = normalized.DIWAN_ALLOWED_EMAIL_DOMAIN;
  }

  return normalized;
}

function applyAlias(env: NodeJS.ProcessEnv, preferred: string, legacy: string): void {
  if (env[preferred]) {
    env[legacy] = env[preferred];
    return;
  }
  if (env[legacy]) {
    console.warn(`${legacy} is deprecated; use ${preferred} instead.`);
  }
}
