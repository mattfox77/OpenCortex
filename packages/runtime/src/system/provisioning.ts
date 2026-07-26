import type { AuthenticatedUser } from '../auth/types.js';
import type { AppConfig } from '../config/config.js';

export function provisioningCommands(
  user: AuthenticatedUser,
  config: AppConfig,
): string[] {
  const workspace = `${config.DIWAN_WORKSPACE_ROOT}/${user.linuxUser}`;
  return [
    `sudo useradd --create-home --shell /bin/bash ${user.linuxUser}`,
    `sudo install -d -o ${user.linuxUser} -g ${user.linuxUser} ${workspace}/repos`,
    `sudo install -d -o ${user.linuxUser} -g ${user.linuxUser} /home/${user.linuxUser}/.config/opencode /home/${user.linuxUser}/.config/gh /home/${user.linuxUser}/.config/acli /home/${user.linuxUser}/.opencode/skills /home/${user.linuxUser}/.codex/skills /home/${user.linuxUser}/.braintrust /home/${user.linuxUser}/.local/share/opencode /home/${user.linuxUser}/.local/state/opencode /home/${user.linuxUser}/.cache/opencode`,
    `sudo ${config.DIWAN_PROVISION_USER_SCRIPT} ${user.linuxUser}`,
    `sudo install -d -o ${user.linuxUser} -g ${user.linuxUser} /home/${user.linuxUser}/.aws /home/${user.linuxUser}/.azure /home/${user.linuxUser}/.ssh`,
  ];
}
