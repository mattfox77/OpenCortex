import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { provisioningCommands } from '../src/system/provisioning.js';
import type { AppConfig } from '../src/config/config.js';

const config = {
  OPENCORTEX_WORKSPACE_ROOT: '/srv/opencortex/workspaces',
  OPENCORTEX_PROVISION_USER_SCRIPT: '/opt/opencortex/scripts/provision-opencortex-user.sh',
} as AppConfig;

describe('provisioning', () => {
  it('generates per-user CLI and repo storage directories', () => {
    const commands = provisioningCommands(
      {
        sub: 'sub',
        email: 'mfox@acme.test',
        groups: ['OpenCodeUsers'],
        linuxUser: 'mfox',
      },
      config,
    );

    expect(commands.join('\n')).toContain('/srv/opencortex/workspaces/mfox/repos');
    expect(commands.join('\n')).toContain('/home/mfox/.config/opencode');
    expect(commands.join('\n')).toContain('/home/mfox/.config/gh');
    expect(commands.join('\n')).toContain('/home/mfox/.config/acli');
    expect(commands.join('\n')).toContain('/home/mfox/.local/share/opencode');
    expect(commands.join('\n')).toContain('/home/mfox/.local/state/opencode');
    expect(commands.join('\n')).toContain('/home/mfox/.cache/opencode');
    expect(commands.join('\n')).toContain('/home/mfox/.opencode/skills');
    expect(commands.join('\n')).toContain('/home/mfox/.codex/skills');
    expect(commands.join('\n')).toContain('/home/mfox/.opencortex/memory');
    expect(commands.join('\n')).toContain('/home/mfox/.opencortex/credentials');
    expect(commands.join('\n')).not.toContain('/home/mfox/.braintrust');
    expect(commands.join('\n')).toContain(
      '/opt/opencortex/scripts/provision-opencortex-user.sh mfox',
    );
    expect(commands.join('\n')).not.toContain('/home/mfox-dev/.claude/skills');
    expect(commands.join('\n')).not.toContain('/home/mfox/.aws');
  });
});

describe('server installer', () => {
  it('bootstraps the shared CLI toolchain for all OpenCortex users', () => {
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
      'for required in node npm npx git jq gh acli',
    );
    expect(installer).not.toContain('awscli');
    expect(installer).not.toContain('aws-cli/2');
    expect(installer).toContain('OPENCORTEX_SKILLS_BUNDLE_PATH');
    expect(installer).toContain('OPENCORTEX_SKILLS_BUNDLE_URL');
    expect(installer).toContain('/usr/local/bin/brain');
    expect(installer).toContain('/opt/opencortex/memory/scripts/brain');
    expect(installer).not.toContain('/opt/braintrust/dist/brain');
    expect(installer).toContain('continuing without /usr/local/bin/brain');
    expect(installer).toContain('ensure_skills\nensure_brain_cli');
  });
});

describe('user provisioner', () => {
  it('serializes and retries Linux user creation', () => {
    const provisioner = readFileSync('scripts/provision-opencortex-user.sh', 'utf8');

    expect(provisioner).toContain('flock -w 120');
    expect(provisioner).toContain('create_linux_user_with_retry');
    expect(provisioner).toContain('max_attempts=20');
    expect(provisioner).toContain('retrying after passwd lock contention');
  });
});
