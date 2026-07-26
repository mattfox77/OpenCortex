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
import { dirname, join } from 'node:path';
import { nanoid } from 'nanoid';
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
  mode: 'dry-run' | 'sudo' | 'aws-ssm';
  aws?: AwsSessionManagerDetails;
}

export interface CodeThread {
  id: string;
  openCodeSessionId: string;
  name?: string;
  workspaceDir?: string;
  createdAt: string;
  lastSelectedAt: string;
}

export interface AwsSessionManagerDetails {
  region: string;
  targetInstanceId: string;
  remotePort: number;
  localPort: number;
  commandId: string;
  startSessionCommand: string[];
  localUrl: string;
}

export class SessionLauncher {
  constructor(private readonly config: AppConfig) {}

  async launch(user: AuthenticatedUser): Promise<CodeSession> {
    const id = codeWorkspaceId(user);
    const port =
      this.config.DIWAN_OPENCODE_PORT_BASE + Math.floor(Math.random() * 1000);
    // The embedded session opens into the user's git-root "repos" folder under
    // their home. This is the landing place for repos they ask to pull, and
    // OpenCode treats the git root as the project (a fresh chat, no specific
    // repo preselected). Created + git-init'd lazily here so a session can
    // launch even if provision-diwan-user.sh has not run for this user yet.
    const userHome = `/home/${user.linuxUser}`;
    const workspaceDir = `${userHome}/repos`;
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

    const opencodeCommand = [
      this.config.DIWAN_OPENCODE_BIN,
      'web',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(port),
    ];

    // Ensure the repos git root exists and is initialized as the user, then run
    // opencode web from it. Done inside the sudo shell so the dirs/files are
    // owned by the target user (the diwan service user cannot write into homes).
    const prepareUserRuntime = [
      ...opencodeRuntimeEnvironment(userHome).map(
        ([key, value]) => `export ${key}=${shellQuote(value)}`,
      ),
      `mkdir -p ${opencodeRuntimeDirs(userHome).map(shellQuote).join(' ')}`,
      `mkdir -p ${shellQuote(workspaceDir)}`,
      `[ -d ${shellQuote(`${workspaceDir}/.git`)} ] || git -C ${shellQuote(workspaceDir)} init -q`,
    ].join(' && ');

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

    if (this.config.DIWAN_EXEC_MODE === 'aws-ssm') {
      const { aws, openCodeSessionId } = await this.launchAwsSession(
        user,
        id,
        port,
        workspaceDir,
        prepareUserRuntime,
        opencodeCommand,
        logPath,
      );
      return sessionWithActiveThread({
        id,
        openCodeSessionId,
        createdAt: new Date().toISOString(),
        ownerEmail: user.email,
        linuxUser: user.linuxUser,
        workspaceDir,
        port,
        urlPath: aws.localUrl,
        command: aws.startSessionCommand,
        mode: this.config.DIWAN_EXEC_MODE,
        aws,
      });
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
        // DysonCode can still be opened in the iframe. Pair-prompt delivery
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
      urlPath: `${this.config.DIWAN_BASE_PATH.replace(/\/$/, '')}/code/session/${id}/`,
      command,
      mode: this.config.DIWAN_EXEC_MODE,
    });
  }

  private async launchAwsSession(
    user: AuthenticatedUser,
    id: string,
    port: number,
    workspaceDir: string,
    prepareUserRuntime: string,
    opencodeCommand: string[],
    logPath: string,
  ): Promise<{
    aws: AwsSessionManagerDetails;
    openCodeSessionId: string;
  }> {
    if (!this.config.DIWAN_SSM_TARGET_INSTANCE_ID) {
      throw new Error(
        'DIWAN_SSM_TARGET_INSTANCE_ID is required when DIWAN_EXEC_MODE=aws-ssm',
      );
    }

    const localPort =
      this.config.DIWAN_SSM_LOCAL_PORT_BASE -
      this.config.DIWAN_OPENCODE_PORT_BASE +
      port;
    const remoteCommand = awsRemoteLaunchCommand(
      user.linuxUser,
      this.config.DIWAN_PROVISION_USER_SCRIPT,
      workspaceDir,
      prepareUserRuntime,
      opencodeCommand,
      logPath,
      port,
    );
    const parameters = JSON.stringify({ commands: [remoteCommand] });
    const args = [
      'ssm',
      'send-command',
      '--region',
      this.config.DIWAN_AWS_REGION,
      '--instance-ids',
      this.config.DIWAN_SSM_TARGET_INSTANCE_ID,
      '--document-name',
      'AWS-RunShellScript',
      '--comment',
      `diwan-code-session ${id} ${user.email}`,
      '--parameters',
      parameters,
      '--query',
      'Command.CommandId',
      '--output',
      'text',
    ];

    const { stdout } = await execFileAsync(this.config.DIWAN_AWS_BIN, args, {
      timeout: 15000,
    });
    const commandId = stdout.trim();
    if (!commandId) {
      throw new Error('AWS SSM send-command did not return a command id');
    }

    const openCodeSessionId = await waitForAwsOpenCodeSessionId(
      this.config,
      commandId,
    );

    return {
      openCodeSessionId,
      aws: {
        region: this.config.DIWAN_AWS_REGION,
        targetInstanceId: this.config.DIWAN_SSM_TARGET_INSTANCE_ID,
        remotePort: port,
        localPort,
        commandId,
        startSessionCommand: awsStartSessionCommand(
          this.config,
          port,
          localPort,
        ),
        localUrl: `http://127.0.0.1:${localPort}/`,
      },
    };
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

export function awsStartSessionCommand(
  config: AppConfig,
  remotePort: number,
  localPort: number,
): string[] {
  return [
    'aws',
    'ssm',
    'start-session',
    '--region',
    config.DIWAN_AWS_REGION,
    '--target',
    config.DIWAN_SSM_TARGET_INSTANCE_ID,
    '--document-name',
    'AWS-StartPortForwardingSession',
    '--parameters',
    `portNumber=${remotePort},localPortNumber=${localPort}`,
  ];
}

export function awsRemoteLaunchCommand(
  linuxUser: string,
  provisionUserScript: string,
  workspaceDir: string,
  prepareUserRuntime: string,
  opencodeCommand: string[],
  logPath: string,
  port: number,
): string {
  const createSession = [
    `opencode_session_json="$(curl -fsS -X POST http://127.0.0.1:${port}/api/session || curl -fsS -X POST http://127.0.0.1:${port}/session)"`,
    `node -e ${shellQuote('const x=JSON.parse(process.argv[1]); const id=x.id || (x.data && x.data.id); if (!id) process.exit(2); console.log(id)')} "$opencode_session_json"`,
  ].join(' && ');
  const launch = [
    prepareUserRuntime,
    `cd ${shellQuote(workspaceDir)}`,
    `(nohup ${opencodeCommand.map(shellQuote).join(' ')} >> ${shellQuote(logPath)} 2>&1 &)`,
    `for i in $(seq 1 40); do timeout 1 bash -lc '</dev/tcp/127.0.0.1/${port}' && break; if [ "$i" = 40 ]; then echo 'OpenCode did not listen on 127.0.0.1:${port}' >&2; exit 1; fi; sleep 0.2; done`,
    createSession,
  ].join(' && ');

  const provision = [
    'sudo',
    '-n',
    '/usr/bin/bash',
    provisionUserScript,
    linuxUser,
  ]
    .map(shellQuote)
    .join(' ');
  const prepareLog = [
    `install -d -o ${shellQuote(linuxUser)} -g ${shellQuote(linuxUser)} ${shellQuote(dirname(logPath))}`,
    `install -o ${shellQuote(linuxUser)} -g ${shellQuote(linuxUser)} -m 0644 /dev/null ${shellQuote(logPath)}`,
  ].join(' && ');
  const runAsUser = [
    'sudo',
    '-n',
    '-H',
    '-u',
    linuxUser,
    '/usr/bin/bash',
    '-lc',
    launch,
  ]
    .map(shellQuote)
    .join(' ');
  return `${provision} && ${prepareLog} && ${runAsUser}`;
}

export function opencodeRuntimeEnvironment(
  homeDir: string,
): [string, string][] {
  return [
    ['HOME', homeDir],
    ['XDG_CONFIG_HOME', `${homeDir}/.config`],
    ['XDG_DATA_HOME', `${homeDir}/.local/share`],
    ['XDG_STATE_HOME', `${homeDir}/.local/state`],
    ['XDG_CACHE_HOME', `${homeDir}/.cache`],
  ];
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

function opencodeRuntimeDirs(homeDir: string): string[] {
  return [
    `${homeDir}/.config/opencode`,
    `${homeDir}/.local/share/opencode`,
    `${homeDir}/.local/state/opencode`,
    `${homeDir}/.cache/opencode`,
  ];
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

async function waitForAwsOpenCodeSessionId(
  config: AppConfig,
  commandId: string,
): Promise<string> {
  const deadline = Date.now() + 20000;
  let lastMessage = 'AWS SSM command did not return an OpenCode session id';
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFileAsync(
        config.DIWAN_AWS_BIN,
        [
          'ssm',
          'get-command-invocation',
          '--region',
          config.DIWAN_AWS_REGION,
          '--instance-id',
          config.DIWAN_SSM_TARGET_INSTANCE_ID,
          '--command-id',
          commandId,
          '--output',
          'json',
        ],
        { timeout: 10000 },
      );
      const payload = JSON.parse(stdout) as {
        Status?: string;
        StandardOutputContent?: string;
        StandardErrorContent?: string;
      };
      const status = payload.Status ?? '';
      const id = payload.StandardOutputContent?.trim().split(/\s+/).at(-1);
      if (status === 'Success' && id) {
        return id;
      }
      if (['Cancelled', 'Failed', 'TimedOut'].includes(status)) {
        throw new Error(
          payload.StandardErrorContent?.trim() ||
            `AWS SSM launch command ${status.toLowerCase()}`,
        );
      }
      lastMessage = `AWS SSM launch command status: ${status || 'unknown'}`;
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : String(error);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(lastMessage);
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
