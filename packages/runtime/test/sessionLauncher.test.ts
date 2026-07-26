import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  codeWorkspaceId,
  localProvisionCommand,
  opencodeRuntimeEnvironment,
  waitForPort,
} from '../src/code/sessionLauncher.js';
import type { AppConfig } from '../src/config/config.js';

const config = {
  OPENCORTEX_PROVISION_USER_SCRIPT: '/opt/opencortex/scripts/provision-opencortex-user.sh',
} as AppConfig;

describe('SessionLauncher', () => {
  it('uses a stable per-user Code Workspace id', () => {
    expect(codeWorkspaceId({ linuxUser: 'mfox' })).toBe('workspace-mfox');
  });

  it('builds a non-interactive local provisioning command before sudo launch', () => {
    expect(localProvisionCommand(config, { linuxUser: 'grathke' })).toEqual([
      'sudo',
      '-n',
      '/usr/bin/bash',
      '/opt/opencortex/scripts/provision-opencortex-user.sh',
      'grathke',
    ]);
  });

  it("pins OpenCode runtime state to the mapped user's home", () => {
    expect(opencodeRuntimeEnvironment('/home/mfox')).toEqual([
      ['HOME', '/home/mfox'],
      ['XDG_CONFIG_HOME', '/home/mfox/.config'],
      ['XDG_DATA_HOME', '/home/mfox/.local/share'],
      ['XDG_STATE_HOME', '/home/mfox/.local/state'],
      ['XDG_CACHE_HOME', '/home/mfox/.cache'],
      ['OPENCODE_CONFIG', '/home/mfox/.config/opencode/opencode.json'],
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
