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
  config: Pick<AppConfig, 'OPENCORTEX_LINUX_USER_PREFIX'>,
): string {
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
