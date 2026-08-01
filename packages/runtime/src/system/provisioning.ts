import type { AuthenticatedUser } from '../auth/types.js';
import type { AppConfig } from '../config/config.js';

export function provisioningCommands(
  user: AuthenticatedUser,
  config: AppConfig,
): string[] {
  if (config.OPENCORTEX_PROVISION_USER_MODE === 'workflow') {
    return [
      [
        'npm',
        '--prefix',
        'packages/orchestrator',
        'run',
        'provision-user',
        '--',
        '--email',
        shellQuote(user.email),
        '--user',
        shellQuote(user.linuxUser),
        '--queue',
        shellQuote(config.OPENCORTEX_PROVISIONING_TASK_QUEUE),
        '--workspace-root',
        shellQuote(config.OPENCORTEX_WORKSPACE_ROOT),
        '--provision-script',
        shellQuote(config.OPENCORTEX_PROVISION_USER_SCRIPT),
        '--groups',
        shellQuote(user.groups.join(',')),
        '--required-groups',
        shellQuote(config.OIDC_REQUIRED_GROUPS.join(',')),
        '--required-tools',
        shellQuote(config.OPENCORTEX_PROVISIONING_REQUIRED_TOOLS.join(',')),
      ].join(' '),
    ];
  }

  const workspace = `${config.OPENCORTEX_WORKSPACE_ROOT}/${user.linuxUser}`;
  return [
    `sudo useradd --create-home --shell /bin/bash ${user.linuxUser}`,
    `sudo install -d -o ${user.linuxUser} -g ${user.linuxUser} ${workspace}/repos`,
    `sudo install -d -o ${user.linuxUser} -g ${user.linuxUser} /home/${user.linuxUser}/.config/opencode /home/${user.linuxUser}/.config/gh /home/${user.linuxUser}/.config/acli /home/${user.linuxUser}/.opencode/skills /home/${user.linuxUser}/.codex/skills /home/${user.linuxUser}/.opencortex/memory /home/${user.linuxUser}/.opencortex/credentials /home/${user.linuxUser}/.local/share/opencode /home/${user.linuxUser}/.local/state/opencode /home/${user.linuxUser}/.cache/opencode`,
    `sudo ${config.OPENCORTEX_PROVISION_USER_SCRIPT} ${user.linuxUser}`,
    `sudo install -d -o ${user.linuxUser} -g ${user.linuxUser} /home/${user.linuxUser}/.azure /home/${user.linuxUser}/.ssh`,
  ];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
