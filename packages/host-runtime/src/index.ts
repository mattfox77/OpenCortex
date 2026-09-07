import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

export type HostSessionDriverId = "direct-process" | "herdr";

export interface HostCapabilityProbe {
  driverId: HostSessionDriverId;
  driverVersion: string;
  available: boolean;
  providers: HostProviderCapability[];
  labels: string[];
  pathRoots: string[];
  diagnostics?: Record<string, unknown>;
}

export interface HostProviderCapability {
  providerId: string;
  providerVersion?: string;
  ready: boolean;
  reason?: string;
}

export interface HostWorkspaceRequest {
  workspaceId: string;
  path: string;
  pathRoots: string[];
}

export interface HostWorkspace {
  workspaceId: string;
  path: string;
}

export interface HostCommandRequest {
  workspace: HostWorkspace;
  command: string[];
  env?: Record<string, string>;
}

export interface HostPane {
  paneId: string;
  workspaceId: string;
  title?: string;
}

export interface HostCommandHandle {
  sessionId: string;
  paneId: string;
  pid?: number;
}

export interface HostOutputSnapshot {
  sessionId: string;
  stdout: string;
  stderr: string;
  truncated: boolean;
  exitCode?: number;
  signal?: string;
}

export interface HostSessionSnapshot {
  sessionId: string;
  paneId: string;
  workspaceId: string;
  status: "starting" | "running" | "exited" | "stopped" | "archived";
  pid?: number;
  exitCode?: number;
  signal?: string;
}

export interface HostSessionDriver {
  readonly id: HostSessionDriverId;
  probe(): Promise<HostCapabilityProbe>;
  createWorkspace(request: HostWorkspaceRequest): Promise<HostWorkspace>;
  createPane(workspace: HostWorkspace, title?: string): Promise<HostPane>;
  startCommand(
    pane: HostPane,
    request: HostCommandRequest,
  ): Promise<HostCommandHandle>;
  sendInput(sessionId: string, input: string): Promise<void>;
  readOutput(sessionId: string, maxBytes: number): Promise<HostOutputSnapshot>;
  snapshot(sessionId: string): Promise<HostSessionSnapshot | undefined>;
  stop(sessionId: string): Promise<void>;
  archive(sessionId: string): Promise<void>;
  recover(): Promise<HostSessionSnapshot[]>;
}

interface DirectSession {
  sessionId: string;
  paneId: string;
  workspaceId: string;
  child: ChildProcessWithoutNullStreams;
  stdout: Buffer[];
  stderr: Buffer[];
  status: HostSessionSnapshot["status"];
  exitCode?: number;
  signal?: string;
}

export interface DirectProcessHostSessionDriverOptions {
  driverVersion?: string;
  labels?: string[];
  pathRoots?: string[];
  providers?: HostProviderCapability[];
}

export class DirectProcessHostSessionDriver implements HostSessionDriver {
  readonly id = "direct-process" as const;
  private readonly sessions = new Map<string, DirectSession>();
  private readonly driverVersion: string;
  private readonly labels: string[];
  private readonly pathRoots: string[];
  private readonly providers: HostProviderCapability[];

  constructor(options: DirectProcessHostSessionDriverOptions = {}) {
    this.driverVersion = options.driverVersion ?? "0.1.0";
    this.labels = options.labels ?? ["local", "direct-process"];
    this.pathRoots = options.pathRoots ?? [process.cwd()];
    this.providers = options.providers ?? [];
  }

  async probe(): Promise<HostCapabilityProbe> {
    return {
      driverId: this.id,
      driverVersion: this.driverVersion,
      available: true,
      providers: this.providers,
      labels: this.labels,
      pathRoots: this.pathRoots,
    };
  }

  async createWorkspace(
    request: HostWorkspaceRequest,
  ): Promise<HostWorkspace> {
    const path = assertPathWithinRoots(request.path, request.pathRoots);
    mkdirSync(path, { recursive: true });
    return {
      workspaceId: request.workspaceId,
      path: realpathSync(path),
    };
  }

  async createPane(
    workspace: HostWorkspace,
    title?: string,
  ): Promise<HostPane> {
    return {
      paneId: `pane-${workspace.workspaceId}`,
      workspaceId: workspace.workspaceId,
      title,
    };
  }

  async startCommand(
    pane: HostPane,
    request: HostCommandRequest,
  ): Promise<HostCommandHandle> {
    if (request.command.length === 0) {
      throw new Error("Host command must include an executable");
    }
    const child = spawn(request.command[0], request.command.slice(1), {
      cwd: request.workspace.path,
      env: { ...process.env, ...(request.env ?? {}) },
    });
    const sessionId = `session-${Date.now()}-${this.sessions.size + 1}`;
    const session: DirectSession = {
      sessionId,
      paneId: pane.paneId,
      workspaceId: request.workspace.workspaceId,
      child,
      stdout: [],
      stderr: [],
      status: "running",
    };
    child.stdout.on("data", (chunk: Buffer) => session.stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => session.stderr.push(chunk));
    child.once("exit", (exitCode, signal) => {
      session.status = "exited";
      session.exitCode = exitCode ?? undefined;
      session.signal = signal ?? undefined;
    });
    this.sessions.set(sessionId, session);
    return {
      sessionId,
      paneId: pane.paneId,
      pid: child.pid,
    };
  }

  async sendInput(sessionId: string, input: string): Promise<void> {
    const session = this.requireSession(sessionId);
    session.child.stdin.write(input);
  }

  async readOutput(
    sessionId: string,
    maxBytes: number,
  ): Promise<HostOutputSnapshot> {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new Error("maxBytes must be a positive integer");
    }
    const session = this.requireSession(sessionId);
    const stdout = boundedBufferText(session.stdout, maxBytes);
    const stderr = boundedBufferText(session.stderr, maxBytes);
    return {
      sessionId,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.truncated || stderr.truncated,
      exitCode: session.exitCode,
      signal: session.signal,
    };
  }

  async snapshot(
    sessionId: string,
  ): Promise<HostSessionSnapshot | undefined> {
    const session = this.sessions.get(sessionId);
    return session ? sessionSnapshot(session) : undefined;
  }

  async stop(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    if (session.status === "running") {
      session.child.kill("SIGTERM");
      session.status = "stopped";
    }
  }

  async archive(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    if (session.status === "running") {
      session.child.kill("SIGTERM");
    }
    session.status = "archived";
  }

  async recover(): Promise<HostSessionSnapshot[]> {
    return [...this.sessions.values()].map(sessionSnapshot);
  }

  private requireSession(sessionId: string): DirectSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown host session ${sessionId}`);
    }
    return session;
  }
}

export class HerdrHostSessionDriver implements HostSessionDriver {
  readonly id = "herdr" as const;

  async probe(): Promise<HostCapabilityProbe> {
    return {
      driverId: this.id,
      driverVersion: "unconfigured",
      available: false,
      providers: [],
      labels: ["herdr"],
      pathRoots: [],
      diagnostics: {
        reason: "Herdr socket contract is not configured in this package yet.",
      },
    };
  }

  async createWorkspace(): Promise<HostWorkspace> {
    throw herdrUnavailable();
  }

  async createPane(): Promise<HostPane> {
    throw herdrUnavailable();
  }

  async startCommand(): Promise<HostCommandHandle> {
    throw herdrUnavailable();
  }

  async sendInput(): Promise<void> {
    throw herdrUnavailable();
  }

  async readOutput(): Promise<HostOutputSnapshot> {
    throw herdrUnavailable();
  }

  async snapshot(): Promise<HostSessionSnapshot | undefined> {
    throw herdrUnavailable();
  }

  async stop(): Promise<void> {
    throw herdrUnavailable();
  }

  async archive(): Promise<void> {
    throw herdrUnavailable();
  }

  async recover(): Promise<HostSessionSnapshot[]> {
    throw herdrUnavailable();
  }
}

export function assertPathWithinRoots(path: string, roots: string[]): string {
  if (roots.length === 0) {
    throw new Error("At least one workspace root is required");
  }
  const resolvedPath = resolve(path);
  const allowed = roots.some((root) => {
    const resolvedRoot = resolve(root);
    return (
      resolvedPath === resolvedRoot ||
      resolvedPath.startsWith(`${resolvedRoot}/`)
    );
  });
  if (!allowed) {
    throw new Error(`Workspace path escapes allowed roots: ${path}`);
  }
  return resolvedPath;
}

function sessionSnapshot(session: DirectSession): HostSessionSnapshot {
  return {
    sessionId: session.sessionId,
    paneId: session.paneId,
    workspaceId: session.workspaceId,
    status: session.status,
    pid: session.child.pid,
    exitCode: session.exitCode,
    signal: session.signal,
  };
}

function boundedBufferText(
  chunks: Buffer[],
  maxBytes: number,
): { text: string; truncated: boolean } {
  const buffer = Buffer.concat(chunks);
  if (buffer.byteLength <= maxBytes) {
    return { text: buffer.toString("utf8"), truncated: false };
  }
  return {
    text: buffer.subarray(buffer.byteLength - maxBytes).toString("utf8"),
    truncated: true,
  };
}

function herdrUnavailable(): Error {
  return new Error("Herdr host session driver is not configured");
}
