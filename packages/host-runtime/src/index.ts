import {
  execFile,
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PINNED_HERDR_PROTOCOL_VERSION = 10;

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
  cwd?: string;
  detached?: boolean;
  outputPath?: string;
  readiness?: HostReadinessProbe;
  unref?: boolean;
}

export interface HostReadinessProbe {
  type: "tcp-port";
  host?: string;
  port: number;
  timeoutMs: number;
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
  nativeSession?: Record<string, unknown>;
  raw?: Record<string, unknown>;
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

export interface HostSelectionCandidate {
  id: string;
  status: "online" | "stale" | "offline" | "unknown" | "archived";
  labels?: string[];
  capacity?: { availableSessions?: number; maxSessions?: number };
  pathRoots?: string[];
  capabilities?: Array<{
    subject: string;
    linuxUser: string;
    providers?: Array<{ providerId: string; ready: boolean }>;
  }>;
}

export interface HostSelectionRequest {
  subject: string;
  linuxUser: string;
  providerId: string;
  explicitHostId?: string;
  requiredLabels?: string[];
  repositoryPath?: string;
}

export interface HostSelectionRejection {
  hostId: string;
  reason: string;
}

export interface HostSelectionResult {
  selected?: HostSelectionCandidate;
  rejected: HostSelectionRejection[];
}

interface DirectSession {
  sessionId: string;
  paneId: string;
  workspaceId: string;
  child: ChildProcess | ChildProcessWithoutNullStreams;
  stdout: Buffer[];
  stderr: Buffer[];
  outputPath?: string;
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
    const logFd = request.outputPath
      ? openHostOutputFile(request.outputPath)
      : undefined;
    const child = spawn(request.command[0], request.command.slice(1), {
      cwd: request.cwd ?? request.workspace.path,
      env: { ...process.env, ...(request.env ?? {}) },
      detached: request.detached,
      stdio: logFd === undefined ? "pipe" : ["ignore", logFd, logFd],
    });
    const sessionId = `session-${Date.now()}-${this.sessions.size + 1}`;
    const session: DirectSession = {
      sessionId,
      paneId: pane.paneId,
      workspaceId: request.workspace.workspaceId,
      child,
      stdout: [],
      stderr: [],
      outputPath: request.outputPath,
      status: "running",
    };
    child.stdout?.on("data", (chunk: Buffer) => session.stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => session.stderr.push(chunk));
    child.once("exit", (exitCode, signal) => {
      session.status = "exited";
      session.exitCode = exitCode ?? undefined;
      session.signal = signal ?? undefined;
    });
    this.sessions.set(sessionId, session);
    try {
      if (request.readiness) {
        await waitForHostReadiness(request.readiness, child);
      }
    } catch (error) {
      child.kill();
      throw error;
    } finally {
      if (logFd !== undefined) {
        closeSync(logFd);
      }
    }
    if (request.unref) {
      child.unref();
    }
    return {
      sessionId,
      paneId: pane.paneId,
      pid: child.pid,
    };
  }

  async sendInput(sessionId: string, input: string): Promise<void> {
    const session = this.requireSession(sessionId);
    if (!session.child.stdin) {
      throw new Error(`Host session ${sessionId} does not accept stdin`);
    }
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
    const stdout = session.outputPath
      ? boundedBufferText([readFileSync(session.outputPath)], maxBytes)
      : boundedBufferText(session.stdout, maxBytes);
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
  private readonly binaryPath: string;
  private readonly labels: string[];
  private readonly pathRoots: string[];
  private readonly providers: HostProviderCapability[];
  private readonly runCommand: HerdrCommandRunner;
  private readonly linuxUser: string | undefined;
  private readonly socketPath: string | undefined;

  constructor(options: HerdrHostSessionDriverOptions = {}) {
    this.binaryPath = options.binaryPath ?? "herdr";
    this.labels = options.labels ?? ["local", "herdr"];
    this.pathRoots = options.pathRoots ?? [];
    this.providers = options.providers ?? [];
    this.linuxUser = options.linuxUser;
    this.socketPath = options.socketPath;
    this.runCommand =
      options.runCommand ??
      ((args) =>
        defaultHerdrCommandRunner(this.binaryPath, args, {
          linuxUser: this.linuxUser,
          socketPath: this.socketPath,
        }));
  }

  async probe(): Promise<HostCapabilityProbe> {
    try {
      const version = String(await this.runCommand(["--version"])).trim();
      const schema = await this.runCommand(["api", "schema", "--json"]);
      const protocolVersion = protocolVersionFromSchema(schema);
      return {
        driverId: this.id,
        driverVersion: version,
        available: protocolVersion === PINNED_HERDR_PROTOCOL_VERSION,
        providers: this.providers,
        labels: this.labels,
        pathRoots: this.pathRoots,
        diagnostics: {
          protocolVersion,
          pinnedProtocolVersion: PINNED_HERDR_PROTOCOL_VERSION,
          linuxUser: this.linuxUser,
          socketPath: this.socketPath,
          schema,
        },
      };
    } catch (error) {
      return {
        driverId: this.id,
        driverVersion: "unavailable",
        available: false,
        providers: this.providers,
        labels: this.labels,
        pathRoots: this.pathRoots,
        diagnostics: {
          reason: error instanceof Error ? error.message : String(error),
          linuxUser: this.linuxUser,
          socketPath: this.socketPath,
        },
      };
    }
  }

  async createWorkspace(
    request: HostWorkspaceRequest,
  ): Promise<HostWorkspace> {
    const path = assertPathWithinRoots(request.path, request.pathRoots);
    const payload = await this.runCommand([
      "workspace",
      "create",
      "--cwd",
      path,
      "--label",
      request.workspaceId,
      "--json",
    ]);
    const workspace = objectAt(payload, "workspace");
    return {
      workspaceId: stringField(workspace, ["workspace_id", "id"], request.workspaceId),
      path: stringField(workspace, ["cwd", "path"], path),
    };
  }

  async createPane(
    workspace: HostWorkspace,
    title?: string,
  ): Promise<HostPane> {
    const args = [
      "tab",
      "create",
      "--workspace",
      workspace.workspaceId,
      "--json",
    ];
    if (title) {
      args.splice(2, 0, "--label", title);
    }
    const payload = await this.runCommand(args);
    const pane = objectAt(payload, "pane") ?? objectAt(payload, "tab");
    return {
      paneId: stringField(pane, ["pane_id", "id"]),
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
    const payload = await this.runCommand([
      "pane",
      "run",
      pane.paneId,
      shellCommand(request.command),
      "--json",
    ]);
    const result = objectAt(payload, "result") ?? asRecord(payload);
    return {
      sessionId: stringField(result, ["pane_id", "terminal_id", "id"], pane.paneId),
      paneId: pane.paneId,
      pid: numberField(result, ["pid"]),
    };
  }

  async sendInput(sessionId: string, input: string): Promise<void> {
    await this.runCommand(["pane", "send-input", sessionId, input, "--json"]);
  }

  async readOutput(
    sessionId: string,
    maxBytes: number,
  ): Promise<HostOutputSnapshot> {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new Error("maxBytes must be a positive integer");
    }
    const payload = await this.runCommand([
      "pane",
      "read",
      sessionId,
      "--source",
      "recent-unwrapped",
      "--lines",
      "200",
      "--format",
      "text",
      "--json",
    ]);
    const result = objectAt(payload, "result") ?? asRecord(payload);
    const text = stringField(result, ["text", "output", "content"], "");
    const bounded = boundedBufferText([Buffer.from(text, "utf8")], maxBytes);
    return {
      sessionId,
      stdout: bounded.text,
      stderr: "",
      truncated: bounded.truncated,
    };
  }

  async snapshot(
    sessionId: string,
  ): Promise<HostSessionSnapshot | undefined> {
    const payload = await this.runCommand(["pane", "get", sessionId, "--json"]);
    const pane = objectAt(payload, "pane") ?? asRecord(payload);
    return snapshotFromHerdrPane(pane, sessionId);
  }

  async stop(sessionId: string): Promise<void> {
    await this.runCommand(["pane", "close", sessionId, "--json"]);
  }

  async archive(sessionId: string): Promise<void> {
    await this.stop(sessionId);
  }

  async recover(): Promise<HostSessionSnapshot[]> {
    const payload = await this.runCommand(["pane", "list", "--json"]);
    const panes = arrayAt(payload, "panes");
    return panes.map((pane) =>
      snapshotFromHerdrPane(pane, stringField(pane, ["pane_id", "id"])),
    );
  }
}

export interface HerdrHostSessionDriverOptions {
  binaryPath?: string;
  linuxUser?: string;
  labels?: string[];
  pathRoots?: string[];
  providers?: HostProviderCapability[];
  runCommand?: HerdrCommandRunner;
  socketPath?: string;
}

export type HerdrCommandRunner = (args: string[]) => Promise<unknown>;

export function selectHostForSession(
  candidates: HostSelectionCandidate[],
  request: HostSelectionRequest,
): HostSelectionResult {
  const rejected: HostSelectionRejection[] = [];
  const sorted = [...candidates].sort((a, b) => a.id.localeCompare(b.id));
  for (const candidate of sorted) {
    const reason = hostRejectionReason(candidate, request);
    if (reason) {
      rejected.push({ hostId: candidate.id, reason });
      continue;
    }
    return { selected: candidate, rejected };
  }
  return { rejected };
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

function openHostOutputFile(path: string): number {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "", { encoding: "utf8" });
  return openSync(path, "a");
}

function waitForHostReadiness(
  readiness: HostReadinessProbe,
  child: ChildProcess,
): Promise<void> {
  const startedAt = Date.now();
  const host = readiness.host ?? "127.0.0.1";

  return new Promise((resolvePromise, reject) => {
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
      child.off("exit", onExit);
      child.off("error", onChildError);
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
      if (Date.now() - startedAt >= readiness.timeoutMs) {
        finish(() =>
          reject(
            new Error(
              childExit
                ? `Process exited before port ${readiness.port} became ready (code=${childExit.code}, signal=${childExit.signal})`
                : `Timed out waiting for port ${readiness.port}`,
            ),
          ),
        );
        return;
      }

      const socket = net.createConnection({ host, port: readiness.port });
      socket.once("connect", () => {
        socket.destroy();
        finish(resolvePromise);
      });
      socket.once("error", () => {
        socket.destroy();
        timer = setTimeout(retry, 100);
      });
    };

    child.once("exit", onExit);
    child.once("error", onChildError);
    retry();
  });
}

async function defaultHerdrCommandRunner(
  binaryPath: string,
  args: string[],
  options: { linuxUser?: string; socketPath?: string } = {},
): Promise<unknown> {
  const command = options.linuxUser ? "sudo" : binaryPath;
  const commandArgs = options.linuxUser
    ? ["-n", "-H", "-u", options.linuxUser, binaryPath, ...args]
    : args;
  const { stdout } = await execFileAsync(command, commandArgs, {
    env: {
      ...process.env,
      ...(options.socketPath
        ? {
            HERDR_SOCKET_PATH: options.socketPath,
          }
        : {}),
    },
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  const output = stdout.trim();
  if (args.includes("--json")) {
    return JSON.parse(output);
  }
  return output;
}

function protocolVersionFromSchema(payload: unknown): number | undefined {
  const schema = asRecord(payload);
  const value =
    schema.protocol_version ??
    schema.protocolVersion ??
    objectAt(schema, "metadata")?.protocol_version ??
    objectAt(schema, "metadata")?.protocolVersion;
  return typeof value === "number" ? value : undefined;
}

function objectAt(
  payload: unknown,
  key: string,
): Record<string, unknown> | undefined {
  const object = asRecord(payload);
  const value = object[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function arrayAt(payload: unknown, key: string): Record<string, unknown>[] {
  const value = asRecord(payload)[key];
  return Array.isArray(value)
    ? value.filter((item) => item && typeof item === "object")
    : [];
}

function asRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function stringField(
  object: Record<string, unknown> | undefined,
  keys: string[],
  fallback?: string,
): string {
  for (const key of keys) {
    const value = object?.[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error(`Herdr response missing string field: ${keys.join(", ")}`);
}

function numberField(
  object: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "number") {
      return value;
    }
  }
  return undefined;
}

function snapshotFromHerdrPane(
  pane: Record<string, unknown>,
  fallbackId: string,
): HostSessionSnapshot {
  const paneId = stringField(pane, ["pane_id", "id"], fallbackId);
  const workspaceId = stringField(pane, ["workspace_id", "workspaceId"], "");
  const state = stringField(pane, ["state", "status"], "running");
  return {
    sessionId: paneId,
    paneId,
    workspaceId,
    status: normalizeHerdrStatus(state),
    pid: numberField(pane, ["pid"]),
    nativeSession: objectAt(pane, "agent_session"),
    raw: pane,
  };
}

function normalizeHerdrStatus(value: string): HostSessionSnapshot["status"] {
  if (["exited", "stopped", "archived"].includes(value)) {
    return value as HostSessionSnapshot["status"];
  }
  return "running";
}

function shellCommand(command: string[]): string {
  return command.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function hostRejectionReason(
  candidate: HostSelectionCandidate,
  request: HostSelectionRequest,
): string | undefined {
  if (request.explicitHostId && candidate.id !== request.explicitHostId) {
    return "not_explicit_host";
  }
  if (candidate.status !== "online") {
    return `host_${candidate.status}`;
  }
  const labels = new Set(candidate.labels ?? []);
  for (const label of request.requiredLabels ?? []) {
    if (!labels.has(label)) {
      return `missing_label:${label}`;
    }
  }
  if (
    request.repositoryPath &&
    candidate.pathRoots?.length &&
    !pathIsWithinAnyRoot(request.repositoryPath, candidate.pathRoots)
  ) {
    return "repository_not_local";
  }
  if ((candidate.capacity?.availableSessions ?? 1) <= 0) {
    return "capacity_full";
  }
  const capability = candidate.capabilities?.find(
    (item) =>
      item.subject === request.subject &&
      item.linuxUser === request.linuxUser &&
      item.providers?.some(
        (provider) =>
          provider.providerId === request.providerId && provider.ready,
      ),
  );
  if (!capability) {
    return "provider_not_ready";
  }
  return undefined;
}

function pathIsWithinAnyRoot(path: string, roots: string[]): boolean {
  try {
    assertPathWithinRoots(path, roots);
    return true;
  } catch {
    return false;
  }
}
