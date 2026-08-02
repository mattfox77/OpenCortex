import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { provisioningCommands } from '../src/system/provisioning.js';
import type { AppConfig } from '../src/config/config.js';

const config = {
  OIDC_REQUIRED_GROUPS: ['OpenCodeUsers'],
  OPENCORTEX_PROVISION_USER_MODE: 'local',
  OPENCORTEX_PROVISIONING_REQUIRED_TOOLS: ['node', 'npm', 'git', 'opencode', 'cortex'],
  OPENCORTEX_PROVISIONING_TASK_QUEUE: 'cortex-tasks',
  OPENCORTEX_WORKSPACE_ROOT: '/srv/opencortex/workspaces',
  OPENCORTEX_WORKBENCH_SESSION_MODE: 'local',
  OPENCORTEX_WORKBENCH_SESSION_TASK_QUEUE: 'cortex-tasks',
  OPENCORTEX_WORKBENCH_SESSION_RUNTIME_BASE_URL: 'http://127.0.0.1:8080/api',
  OPENCORTEX_WORKBENCH_SESSION_MONITOR_INTERVAL: '30 seconds',
  OPENCORTEX_WORKBENCH_SESSION_MAX_PROBES: 0,
  OPENCORTEX_REVIEW_MODE: 'local',
  OPENCORTEX_REVIEW_TASK_QUEUE: 'cortex-tasks',
  OPENCORTEX_PAIR_PROMPT_MODE: 'local',
  OPENCORTEX_PAIR_PROMPT_TASK_QUEUE: 'cortex-tasks',
  OPENCORTEX_PAIR_PROMPT_RUNTIME_BASE_URL: 'http://127.0.0.1:8080/api',
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

  it('points operators at UserProvisioningWorkflow when workflow mode is enabled', () => {
    const commands = provisioningCommands(
      {
        sub: 'sub',
        email: 'mfox@acme.test',
        groups: ['OpenCodeUsers', 'Admins'],
        linuxUser: 'mfox',
      },
      {
        ...config,
        OPENCORTEX_PROVISION_USER_MODE: 'workflow',
        OPENCORTEX_PROVISIONING_TASK_QUEUE: 'user-provisioning',
      },
    );

    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('npm --prefix packages/orchestrator run provision-user');
    expect(commands[0]).toContain('--email \'mfox@acme.test\'');
    expect(commands[0]).toContain('--user \'mfox\'');
    expect(commands[0]).toContain('--queue \'user-provisioning\'');
    expect(commands[0]).toContain('--groups \'OpenCodeUsers,Admins\'');
    expect(commands[0]).toContain('--required-groups \'OpenCodeUsers\'');
    expect(commands[0]).toContain('--required-tools \'node,npm,git,opencode,cortex\'');
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

  it('seeds staged neutral skills into Codex and OpenCode directories', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'opencortex-provision-'));
    try {
      const bin = path.join(root, 'bin');
      const homeRoot = path.join(root, 'home');
      const workspaceRoot = path.join(root, 'workspaces');
      const skillsSource = path.join(root, 'staged-skills');

      await mkdir(path.join(skillsSource, 'opencortex-memory'), { recursive: true });
      await mkdir(path.join(skillsSource, 'opencortex-workbench'), { recursive: true });
      await writeFile(
        path.join(skillsSource, 'opencortex-memory', 'SKILL.md'),
        '---\nname: opencortex-memory\ndescription: Memory acceptance fixture.\n---\n',
      );
      await writeFile(
        path.join(skillsSource, 'opencortex-workbench', 'SKILL.md'),
        '---\nname: opencortex-workbench\ndescription: Workbench acceptance fixture.\n---\n',
      );
      await installProvisioningMocks(bin);

      const result = spawnSync('bash', ['scripts/provision-opencortex-user.sh', 'alice'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          OPENCORTEX_HOME_ROOT: homeRoot,
          OPENCORTEX_WORKSPACE_ROOT: workspaceRoot,
          OPENCORTEX_SKILLS_DIR: skillsSource,
        },
      });

      expect(result.status, result.stderr).toBe(0);
      for (const target of ['.codex/skills', '.opencode/skills']) {
        expect(
          existsSync(
            path.join(homeRoot, 'alice', target, 'opencortex-memory', 'SKILL.md'),
          ),
        ).toBe(true);
        expect(
          existsSync(
            path.join(homeRoot, 'alice', target, 'opencortex-workbench', 'SKILL.md'),
          ),
        ).toBe(true);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function installProvisioningMocks(bin: string) {
  await mkdir(bin, { recursive: true });
  await writeExecutable(path.join(bin, 'id'), '#!/usr/bin/env bash\nexit 0\n');
  await writeExecutable(path.join(bin, 'chown'), '#!/usr/bin/env bash\nexit 0\n');
  await writeExecutable(path.join(bin, 'chmod'), '#!/usr/bin/env bash\nexit 0\n');
  await writeExecutable(
    path.join(bin, 'install'),
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -gt 0 ] && [ "$1" = "-d" ]; then
  shift
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -o|-g|-m)
        shift 2
        ;;
      -*)
        shift
        ;;
      *)
        mkdir -p "$1"
        shift
        ;;
    esac
  done
  exit 0
fi
exec /usr/bin/install "$@"
`,
  );
  await writeExecutable(
    path.join(bin, 'sudo'),
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -ge 2 ] && [ "$1" = "-u" ]; then
  shift 2
fi
exec "$@"
`,
  );
  await writeExecutable(
    path.join(bin, 'git'),
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -ge 4 ] && [ "$1" = "-C" ] && [ "$3" = "init" ]; then
  mkdir -p "$2/.git"
fi
`,
  );
  await writeExecutable(
    path.join(bin, 'rsync'),
    `#!/usr/bin/env bash
set -euo pipefail
args=()
for arg in "$@"; do
  case "$arg" in
    -*)
      ;;
    *)
      args+=("$arg")
      ;;
  esac
done
last_index=$((\${#args[@]} - 1))
src="\${args[$last_index - 1]}"
dest="\${args[$last_index]}"
mkdir -p "$dest"
cp -a "$src"/. "$dest"/
`,
  );
}

async function writeExecutable(file: string, contents: string) {
  await writeFile(file, contents, { mode: 0o755 });
}
