import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import {
  OpenCodeWorkbenchProvider,
  opencodeRuntimeEnvironment as workbenchOpencodeRuntimeEnvironment,
  type WorkbenchLaunchPlan,
} from '@opencortex/workbench';
import type { AuthenticatedUser } from '../auth/types.js';
import type { AppConfig } from '../config/config.js';
import { createOpenCodeSession } from './openCodePromptClient.js';

const execFileAsync = promisify(execFile);

export interface CodeSession {
  id: string;
  openCodeSessionId?: string;
  name?: string;
  activeThreadId?: string;
  threads?: CodeThread[];
  createdAt: string;
  ownerEmail: string;
  linuxUser: string;
  workspaceDir: string;
  port: number;
  urlPath: string;
  command: string[];
  mode: 'dry-run' | 'sudo';
}

export interface CodeThread {
  id: string;
  openCodeSessionId: string;
  name?: string;
  workspaceDir?: string;
  createdAt: string;
  lastSelectedAt: string;
}

export class SessionLauncher {
  constructor(
    private readonly config: AppConfig,
    private readonly workbenchProvider = new OpenCodeWorkbenchProvider(),
  ) {}

  async launch(user: AuthenticatedUser): Promise<CodeSession> {
    const id = codeWorkspaceId(user);
    const port =
      this.config.DIWAN_OPENCODE_PORT_BASE + Math.floor(Math.random() * 1000);
    const launchPlan = this.workbenchProvider.planLaunch({
      user,
      sessionId: id,
      port,
      basePath: this.config.DIWAN_BASE_PATH,
      dataDir: this.config.DIWAN_DATA_DIR,
      binaryPath: this.config.DIWAN_OPENCODE_BIN,
      mode: this.config.DIWAN_EXEC_MODE,
    });
    const workspaceDir = launchPlan.workspaceDir;
    const logPath = join(
      this.config.DIWAN_DATA_DIR,
      'code-session-logs',
      `${id}.log`,
    );
    if (this.config.DIWAN_EXEC_MODE !== 'dry-run') {
      mkdirSync(join(this.config.DIWAN_DATA_DIR, 'code-session-logs'), {
        recursive: true,
      });
    }

    const opencodeCommand = launchPlan.command;

    // Ensure the repos git root exists and is initialized as the user, then run
    // opencode web from it. Done inside the sudo shell so the dirs/files are
    // owned by the target user (the diwan service user cannot write into homes).
    const prepareUserRuntime = prepareWorkbenchRuntime(launchPlan);

    const command =
      this.config.DIWAN_EXEC_MODE === 'sudo'
        ? [
            'sudo',
            '-n',
            '-H',
            '-u',
            user.linuxUser,
            '/usr/bin/bash',
            '-lc',
            `${prepareUserRuntime} && cd ${shellQuote(workspaceDir)} && ${opencodeCommand.map(shellQuote).join(' ')}`,
          ]
        : opencodeCommand;

    if (this.config.DIWAN_EXEC_MODE === 'sudo') {
      await provisionLocalUser(this.config, user);
    }

    let openCodeSessionId: string | undefined;
    if (this.config.DIWAN_EXEC_MODE === 'sudo') {
      writeFileSync(logPath, '', { encoding: 'utf8' });
      const logFd = openSync(logPath, 'a');
      const child = spawn(command[0], command.slice(1), {
        detached: true,
        stdio: ['ignore', logFd, logFd],
      });
      try {
        await waitForPort(port, child, 8000);
      } catch (error) {
        child.kill();
        throw new Error(
          appendLogExcerpt(
            `${error instanceof Error ? error.message : 'OpenCode failed to start or initialize'}; log: ${logPath}`,
            logPath,
          ),
        );
      }
      try {
        openCodeSessionId = await createOpenCodeSession(port);
      } catch {
        // OpenCortex Workbench can still be opened in the iframe. Pair-prompt delivery
        // will report a missing internal session id until OpenCode exposes one.
      } finally {
        closeSync(logFd);
      }
      child.unref();
    }

    return sessionWithActiveThread({
      id,
      ...(openCodeSessionId ? { openCodeSessionId } : {}),
      createdAt: new Date().toISOString(),
      ownerEmail: user.email,
      linuxUser: user.linuxUser,
      workspaceDir,
      port,
      urlPath: launchPlan.urlPath,
      command,
      mode: this.config.DIWAN_EXEC_MODE,
    });
  }

}

export function sessionWithActiveThread(session: CodeSession): CodeSession {
  if (!session.openCodeSessionId) {
    return session;
  }
  const now = new Date().toISOString();
  const existing = session.threads?.find(
    thread => thread.openCodeSessionId === session.openCodeSessionId,
  );
  const thread =
    existing ??
    ({
      id: `thread-${nanoid(12)}`,
      openCodeSessionId: session.openCodeSessionId,
      ...(session.name ? { name: session.name } : {}),
      createdAt: now,
      lastSelectedAt: now,
    } satisfies CodeThread);
  thread.lastSelectedAt = now;
  if (session.name && !thread.name) {
    thread.name = session.name;
  }
  const threads = [
    ...(session.threads ?? []).filter(item => item.id !== thread.id),
    thread,
  ];
  return {
    ...session,
    activeThreadId: thread.id,
    threads,
  };
}

export function activeCodeThread(session: CodeSession): CodeThread | undefined {
  if (session.activeThreadId) {
    const active = session.threads?.find(
      thread => thread.id === session.activeThreadId,
    );
    if (active) {
      return active;
    }
  }
  const byOpenCodeId = session.threads?.find(
    thread => thread.openCodeSessionId === session.openCodeSessionId,
  );
  if (byOpenCodeId) {
    return byOpenCodeId;
  }
  return session.openCodeSessionId
    ? {
        id: `legacy-${session.openCodeSessionId}`,
        openCodeSessionId: session.openCodeSessionId,
        ...(session.name ? { name: session.name } : {}),
        createdAt: session.createdAt,
        lastSelectedAt: session.createdAt,
      }
    : undefined;
}

export function codeWorkspaceId(
  user: Pick<AuthenticatedUser, 'linuxUser'>,
): string {
  return `workspace-${user.linuxUser}`;
}

export function opencodeRuntimeEnvironment(
  homeDir: string,
): [string, string][] {
  return Object.entries(workbenchOpencodeRuntimeEnvironment(homeDir));
}

export async function provisionLocalUser(
  config: Pick<AppConfig, 'DIWAN_PROVISION_USER_SCRIPT'>,
  user: Pick<AuthenticatedUser, 'linuxUser'>,
): Promise<void> {
  try {
    const command = localProvisionCommand(config, user);
    await execFileAsync(command[0], command.slice(1), { timeout: 30000 });
  } catch (error) {
    throw new Error(
      `Failed to provision Linux user ${user.linuxUser}: ${errorMessage(error)}`,
    );
  }
}

export function localProvisionCommand(
  config: Pick<AppConfig, 'DIWAN_PROVISION_USER_SCRIPT'>,
  user: Pick<AuthenticatedUser, 'linuxUser'>,
): string[] {
  return [
    'sudo',
    '-n',
    '/usr/bin/bash',
    config.DIWAN_PROVISION_USER_SCRIPT,
    user.linuxUser,
  ];
}

function prepareWorkbenchRuntime(launchPlan: WorkbenchLaunchPlan): string {
  return [
    ...Object.entries(launchPlan.environment).map(
      ([key, value]) => `export ${key}=${shellQuote(value)}`,
    ),
    `mkdir -p ${launchPlan.runtimeDirs.map(shellQuote).join(' ')}`,
    `mkdir -p ${shellQuote(launchPlan.workspaceDir)}`,
    `[ -d ${shellQuote(`${launchPlan.workspaceDir}/.git`)} ] || git -C ${shellQuote(launchPlan.workspaceDir)} init -q`,
  ].join(' && ');
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const details = [
    error.message,
    'stdout' in error && typeof error.stdout === 'string'
      ? error.stdout.trim()
      : '',
    'stderr' in error && typeof error.stderr === 'string'
      ? error.stderr.trim()
      : '',
  ].filter(Boolean);
  return details.join('; ');
}

export function waitForPort(
  port: number,
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let childExit:
      | { code: number | null; signal: NodeJS.Signals | null }
      | undefined;

    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      child.off('exit', onExit);
      child.off('error', onChildError);
      callback();
    };

    const onExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      childExit = { code, signal };
    };

    const onChildError = (error: Error): void => {
      finish(() => reject(error));
    };

    const retry = (): void => {
      if (Date.now() - startedAt >= timeoutMs) {
        finish(() =>
          reject(
            childExit
              ? new Error(
                  `OpenCode exited before listening on 127.0.0.1:${port} (code ${childExit.code ?? 'null'}, signal ${childExit.signal ?? 'null'})`,
                )
              : new Error(
                  `OpenCode did not listen on 127.0.0.1:${port} within ${timeoutMs}ms`,
                ),
          ),
        );
        return;
      }
      timer = setTimeout(check, 200);
    };

    const check = (): void => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.setTimeout(500);
      socket.once('connect', () => {
        socket.destroy();
        finish(resolve);
      });
      socket.once('error', () => {
        socket.destroy();
        retry();
      });
      socket.once('timeout', () => {
        socket.destroy();
        retry();
      });
    };

    child.once('exit', onExit);
    child.once('error', onChildError);
    check();
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function appendLogExcerpt(message: string, logPath: string): string {
  try {
    const log = readFileSync(logPath, 'utf8').trim();
    if (!log) {
      return message;
    }
    const excerpt = log.split(/\r?\n/).slice(-20).join('\n');
    return `${message}; log excerpt:\n${excerpt}`;
  } catch {
    return message;
  }
}
