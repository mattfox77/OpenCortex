import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { provisioningCommands } from '../src/system/provisioning.js';
import type { AppConfig } from '../src/config/config.js';

const config = {
  DIWAN_WORKSPACE_ROOT: '/srv/diwan/workspaces',
  DIWAN_PROVISION_USER_SCRIPT: '/opt/opencortex/scripts/provision-diwan-user.sh',
} as AppConfig;

describe('provisioning', () => {
  it('generates per-user CLI and repo storage directories', () => {
    const commands = provisioningCommands(
      {
        sub: 'sub',
        email: 'mfox@dsn.com',
        groups: ['OpenCodeUsers'],
        linuxUser: 'mfox',
      },
      config,
    );

    expect(commands.join('\n')).toContain('/srv/diwan/workspaces/mfox/repos');
    expect(commands.join('\n')).toContain('/home/mfox/.config/opencode');
    expect(commands.join('\n')).toContain('/home/mfox/.config/gh');
    expect(commands.join('\n')).toContain('/home/mfox/.config/acli');
    expect(commands.join('\n')).toContain('/home/mfox/.local/share/opencode');
    expect(commands.join('\n')).toContain('/home/mfox/.local/state/opencode');
    expect(commands.join('\n')).toContain('/home/mfox/.cache/opencode');
    expect(commands.join('\n')).toContain('/home/mfox/.opencode/skills');
    expect(commands.join('\n')).toContain('/home/mfox/.codex/skills');
    expect(commands.join('\n')).toContain('/home/mfox/.braintrust');
    expect(commands.join('\n')).toContain(
      '/opt/opencortex/scripts/provision-diwan-user.sh mfox',
    );
    expect(commands.join('\n')).not.toContain('/home/mfox-dsn/.claude/skills');
    expect(commands.join('\n')).toContain('/home/mfox/.aws');
  });
});

describe('server installer', () => {
  it('bootstraps the shared CLI toolchain for all Diwan users', () => {
    const installer = readFileSync('scripts/install-server.sh', 'utf8');

    expect(installer).toContain('ensure_node');
    expect(installer).toContain('ensure_clis');
    expect(installer).toContain('ensure_brain_cli');
    expect(installer).toContain(
      'ca-certificates curl gnupg unzip git jq python3 make g++',
    );
    expect(installer).toContain('https://cli.github.com/packages');
    expect(installer).toContain('ensure_apt_packages gh');
    expect(installer).toContain(
      'https://acli.atlassian.com/linux/latest/acli_linux_amd64',
    );
    expect(installer).toContain(
      'https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip',
    );
    expect(installer).toContain(
      'for required in node npm npx git jq gh acli aws',
    );
    expect(installer).toContain('aws-cli/2');
    expect(installer).toContain('/usr/local/bin/brain');
    expect(installer).toContain('/opt/braintrust/dist/brain');
    expect(installer).toContain('continuing without /usr/local/bin/brain');
    expect(installer).toContain('ensure_skills\nensure_brain_cli');
  });
});

describe('user provisioner', () => {
  it('serializes and retries Linux user creation', () => {
    const provisioner = readFileSync('scripts/provision-diwan-user.sh', 'utf8');

    expect(provisioner).toContain('flock -w 120');
    expect(provisioner).toContain('create_linux_user_with_retry');
    expect(provisioner).toContain('max_attempts=20');
    expect(provisioner).toContain('retrying after passwd lock contention');
  });
});
