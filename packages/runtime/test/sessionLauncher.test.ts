import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  awsRemoteLaunchCommand,
  awsStartSessionCommand,
  codeWorkspaceId,
  localProvisionCommand,
  opencodeRuntimeEnvironment,
  waitForPort,
} from '../src/code/sessionLauncher.js';
import type { AppConfig } from '../src/config/config.js';

const config = {
  DIWAN_AWS_REGION: 'us-east-1',
  DIWAN_SSM_TARGET_INSTANCE_ID: 'i-abc123',
  DIWAN_PROVISION_USER_SCRIPT: '/opt/diwan/scripts/provision-diwan-user.sh',
} as AppConfig;

describe('AWS Session Manager sessions', () => {
  it('uses a stable per-user Code Workspace id', () => {
    expect(codeWorkspaceId({ linuxUser: 'mfox' })).toBe('workspace-mfox');
  });

  it('builds a port-forwarding start-session command', () => {
    expect(awsStartSessionCommand(config, 4107, 5107)).toEqual([
      'aws',
      'ssm',
      'start-session',
      '--region',
      'us-east-1',
      '--target',
      'i-abc123',
      '--document-name',
      'AWS-StartPortForwardingSession',
      '--parameters',
      'portNumber=4107,localPortNumber=5107',
    ]);
  });

  it('builds a non-interactive local provisioning command before sudo launch', () => {
    expect(localProvisionCommand(config, { linuxUser: 'grathke' })).toEqual([
      'sudo',
      '-n',
      '/usr/bin/bash',
      '/opt/diwan/scripts/provision-diwan-user.sh',
      'grathke',
    ]);
  });

  it('runs OpenCode as the mapped Linux user on the target instance', () => {
    const command = awsRemoteLaunchCommand(
      'mfox',
      '/opt/diwan/scripts/provision-diwan-user.sh',
      '/home/mfox/repos',
      "export HOME='/home/mfox' && export XDG_CONFIG_HOME='/home/mfox/.config' && export XDG_DATA_HOME='/home/mfox/.local/share' && export XDG_STATE_HOME='/home/mfox/.local/state' && export XDG_CACHE_HOME='/home/mfox/.cache' && mkdir -p '/home/mfox/repos'",
      [
        '/usr/local/bin/opencode',
        'web',
        '--hostname',
        '127.0.0.1',
        '--port',
        '4107',
      ],
      '/var/lib/diwan/code-session-logs/session.log',
      4107,
    );

    expect(command).toContain(
      "'sudo' '-n' '/usr/bin/bash' '/opt/diwan/scripts/provision-diwan-user.sh' 'mfox' &&",
    );
    expect(command).toContain(
      "install -d -o 'mfox' -g 'mfox' '/var/lib/diwan/code-session-logs'",
    );
    expect(command).toContain(
      "install -o 'mfox' -g 'mfox' -m 0644 /dev/null '/var/lib/diwan/code-session-logs/session.log'",
    );
    expect(command).toContain("'sudo' '-n' '-H' '-u' 'mfox'");
    expect(command).toContain('export HOME=');
    expect(command).toContain('/home/mfox');
    expect(command).toContain('export XDG_DATA_HOME=');
    expect(command).toContain('/home/mfox/.local/share');
    expect(command).toContain('nohup');
    expect(command).toContain('/usr/local/bin/opencode');
    expect(command).toContain('/dev/tcp/127.0.0.1/4107');
    expect(command).toContain('http://127.0.0.1:4107/api/session');
    expect(command).not.toContain('& &&');
  });

  it("pins OpenCode runtime state to the mapped user's home", () => {
    expect(opencodeRuntimeEnvironment('/home/mfox')).toEqual([
      ['HOME', '/home/mfox'],
      ['XDG_CONFIG_HOME', '/home/mfox/.config'],
      ['XDG_DATA_HOME', '/home/mfox/.local/share'],
      ['XDG_STATE_HOME', '/home/mfox/.local/state'],
      ['XDG_CACHE_HOME', '/home/mfox/.cache'],
    ]);
  });

  it('accepts readiness after a wrapper process exits but the server keeps listening', async () => {
    const port = await freePort();
    const pidFile = join(
      tmpdir(),
      `diwan-session-launcher-${process.pid}-${port}.pid`,
    );
    const serverScript = [
      "const net = require('node:net')",
      'const server = net.createServer()',
      `server.listen(${port}, '127.0.0.1')`,
      'setInterval(() => {}, 1000)',
    ].join(';');
    const child = spawn('/usr/bin/bash', [
      '-lc',
      `node -e ${shellQuote(serverScript)} & echo $! > ${shellQuote(pidFile)}`,
    ]);

    try {
      await expect(waitForPort(port, child, 3000)).resolves.toBeUndefined();
    } finally {
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      if (Number.isFinite(pid)) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // The background process may already have exited if the test failed.
        }
      }
      rmSync(pidFile, { force: true });
    }
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to allocate a local port'));
        return;
      }
      server.close(error => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
