import type { AppConfig } from '../config/config.js';

// Linux usernames are the bare email local-part (no "diwan-" prefix). Because
// there is no prefix namespacing OpenCortex accounts away from system accounts, the
// reserved set must block any name that could collide with a privileged or
// service account on the host.
const reserved = new Set([
  'root',
  'admin',
  'administrator',
  'daemon',
  'bin',
  'sys',
  'sync',
  'diwan',
  'ssm-user',
  'ubuntu',
  'ec2-user',
  'nobody',
  'systemd-network',
  'sshd',
  'www-data',
]);

export function emailToLinuxUser(
  email: string,
  config: Pick<
    AppConfig,
    'OPENCORTEX_LINUX_USER_PREFIX' | 'OPENCORTEX_LINUX_USER_OVERRIDES'
  >,
): string {
  // An explicit mapping wins over derivation, so a federated identity can be
  // attached to an account that already exists on the host. Without this,
  // matt.fox@... derives "matt-fox" and provisioning would create a second,
  // empty account alongside the real one.
  const overrides = config.OPENCORTEX_LINUX_USER_OVERRIDES ?? [];
  const normalizedEmail = email.trim().toLowerCase();
  for (const entry of overrides) {
    const [rawEmail, rawUser] = entry.split('=');
    if (!rawEmail || !rawUser) {
      continue;
    }
    if (rawEmail.trim().toLowerCase() === normalizedEmail) {
      const user = rawUser.trim().toLowerCase();
      if (reserved.has(user)) {
        throw new Error(`Linux user override is a reserved account: ${user}`);
      }
      return user;
    }
  }

  const localPart = email.split('@')[0] ?? '';
  const safeLocal = localPart
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (!safeLocal || reserved.has(safeLocal)) {
    throw new Error('Email cannot be mapped to a safe Linux user');
  }

  return `${config.OPENCORTEX_LINUX_USER_PREFIX}${safeLocal}`.slice(0, 31);
}

export function assertAllowedEmailDomain(email: string, domain: string): void {
  assertAllowedEmailDomains(email, domain ? [domain] : []);
}

export function assertAllowedEmailDomains(email: string, domains: string[]): void {
  if (domains.length === 0) {
    return;
  }
  const normalized = email.trim().toLowerCase();
  const allowed = domains.map(domain => `@${domain.toLowerCase()}`);
  if (!allowed.some(suffix => normalized.endsWith(suffix))) {
    throw new Error(`Email domain is not allowed: expected one of ${allowed.join(', ')}`);
  }
}
