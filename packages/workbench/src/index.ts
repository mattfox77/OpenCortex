import {
  AGENT_CLIENT_PROTOCOL_VERSION,
  type AgentProviderCapabilities,
} from "@opencortex/agent-client";

export const OPENCODE_PROVIDER_ID = "opencode" as const;
export const CODEX_PROVIDER_ID = "codex" as const;
export const CLAUDE_CODE_PROVIDER_ID = "claude-code" as const;
export const PINNED_OPENCODE_VERSION = "1.14.50" as const;
export const PINNED_CODEX_PROVIDER_VERSION = "codexapp" as const;
export const PINNED_CLAUDE_CODE_PROVIDER_VERSION = "claude-cli-remote-control" as const;

export type WorkbenchProviderId =
  | typeof OPENCODE_PROVIDER_ID
  | typeof CODEX_PROVIDER_ID
  | typeof CLAUDE_CODE_PROVIDER_ID;
export type WorkbenchLaunchMode = "dry-run" | "sudo" | "aws-ssm";

export interface WorkbenchUser {
  email: string;
  linuxUser: string;
}

export interface WorkbenchLaunchRequest {
  user: WorkbenchUser;
  sessionId: string;
  port: number;
  basePath: string;
  dataDir: string;
  binaryPath: string;
  mode: WorkbenchLaunchMode;
  initialPrompt?: string;
  displayName?: string;
}

export interface WorkbenchLaunchPlan {
  providerId: WorkbenchProviderId;
  providerVersion: string;
  sessionId: string;
  workspaceDir: string;
  urlPath: string;
  command: string[];
  environment: Record<string, string>;
  runtimeDirs: string[];
}

export interface WorkbenchProvider {
  readonly id: WorkbenchProviderId;
  readonly version: string;
  capabilities(): AgentProviderCapabilities;
  planLaunch(request: WorkbenchLaunchRequest): WorkbenchLaunchPlan;
}

export class OpenCodeWorkbenchProvider implements WorkbenchProvider {
  readonly id = OPENCODE_PROVIDER_ID;
  readonly version = PINNED_OPENCODE_VERSION;

  capabilities(): AgentProviderCapabilities {
    return {
      providerId: this.id,
      protocolVersion: AGENT_CLIENT_PROTOCOL_VERSION,
      providerVersion: this.version,
      controls: ["initialize", "resume", "request_status", "native_link"],
      eventKinds: ["session", "turn", "text", "error"],
      supportsMultipleAccounts: false,
      supportsNativeDeepLinks: false,
      supportsRemoteControl: false,
      supportsAcp: false,
    };
  }

  planLaunch(request: WorkbenchLaunchRequest): WorkbenchLaunchPlan {
    const homeDir = `/home/${request.user.linuxUser}`;
    const workspaceDir = `${homeDir}/repos`;
    const command = [
      request.binaryPath,
      "web",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(request.port),
    ];

    return {
      providerId: this.id,
      providerVersion: this.version,
      sessionId: request.sessionId,
      workspaceDir,
      urlPath: `${request.basePath.replace(/\/$/, "")}/code/session/${request.sessionId}/`,
      command,
      environment: opencodeRuntimeEnvironment(homeDir),
      runtimeDirs: opencodeRuntimeDirs(homeDir),
    };
  }
}

export class CodexWorkbenchProvider implements WorkbenchProvider {
  readonly id = CODEX_PROVIDER_ID;
  readonly version = PINNED_CODEX_PROVIDER_VERSION;

  capabilities(): AgentProviderCapabilities {
    return {
      providerId: this.id,
      protocolVersion: AGENT_CLIENT_PROTOCOL_VERSION,
      providerVersion: this.version,
      controls: [
        "initialize",
        "resume",
        "send_prompt",
        "stream_events",
        "request_status",
        "interrupt",
        "terminate",
        "native_link",
      ],
      eventKinds: [
        "session",
        "turn",
        "text",
        "tool_call",
        "file_touch",
        "diff",
        "usage",
        "completion",
        "error",
      ],
      supportsMultipleAccounts: true,
      supportsNativeDeepLinks: false,
      supportsRemoteControl: false,
      supportsAcp: true,
    };
  }

  planLaunch(request: WorkbenchLaunchRequest): WorkbenchLaunchPlan {
    const homeDir = `/home/${request.user.linuxUser}`;
    const workspaceDir = `${homeDir}/repos`;
    const command = [
      request.binaryPath,
      "--no-tunnel",
      "--no-open",
      "--no-login",
      "--port",
      String(request.port),
      "--open-project",
      workspaceDir,
    ];

    return {
      providerId: this.id,
      providerVersion: this.version,
      sessionId: request.sessionId,
      workspaceDir,
      urlPath: `${request.basePath.replace(/\/$/, "")}/code/session/${request.sessionId}/`,
      command,
      environment: codexRuntimeEnvironment(homeDir),
      runtimeDirs: codexRuntimeDirs(homeDir),
    };
  }
}

export class ClaudeCodeWorkbenchProvider implements WorkbenchProvider {
  readonly id = CLAUDE_CODE_PROVIDER_ID;
  readonly version = PINNED_CLAUDE_CODE_PROVIDER_VERSION;

  capabilities(): AgentProviderCapabilities {
    return {
      providerId: this.id,
      protocolVersion: AGENT_CLIENT_PROTOCOL_VERSION,
      providerVersion: this.version,
      controls: [
        "initialize",
        "resume",
        "send_prompt",
        "stream_events",
        "answer_question",
        "decide_permission",
        "request_status",
        "interrupt",
        "compact",
        "terminate",
        "native_link",
      ],
      eventKinds: [
        "session",
        "turn",
        "text",
        "thought_summary",
        "tool_call",
        "subagent",
        "file_touch",
        "question",
        "permission",
        "diff",
        "usage",
        "cost",
        "completion",
        "interruption",
        "disconnection",
        "error",
      ],
      supportsMultipleAccounts: true,
      supportsNativeDeepLinks: false,
      supportsRemoteControl: true,
      supportsAcp: true,
    };
  }

  planLaunch(request: WorkbenchLaunchRequest): WorkbenchLaunchPlan {
    const homeDir = `/home/${request.user.linuxUser}`;
    const workspaceDir = `${homeDir}/repos`;
    const command = [
      request.binaryPath,
      "--remote-control",
      request.displayName ?? `OpenCortex ${request.sessionId}`,
    ];
    if (request.initialPrompt?.trim()) {
      command.push(request.initialPrompt);
    }

    return {
      providerId: this.id,
      providerVersion: this.version,
      sessionId: request.sessionId,
      workspaceDir,
      urlPath: "https://claude.ai/code",
      command,
      environment: claudeCodeRuntimeEnvironment(homeDir),
      runtimeDirs: claudeCodeRuntimeDirs(homeDir),
    };
  }
}

export function opencodeRuntimeEnvironment(homeDir: string): Record<string, string> {
  return {
    HOME: homeDir,
    XDG_CONFIG_HOME: `${homeDir}/.config`,
    XDG_DATA_HOME: `${homeDir}/.local/share`,
    XDG_STATE_HOME: `${homeDir}/.local/state`,
    XDG_CACHE_HOME: `${homeDir}/.cache`,
    OPENCODE_CONFIG: `${homeDir}/.config/opencode/opencode.json`,
  };
}

export function codexRuntimeEnvironment(homeDir: string): Record<string, string> {
  return {
    HOME: homeDir,
    XDG_CONFIG_HOME: `${homeDir}/.config`,
    XDG_DATA_HOME: `${homeDir}/.local/share`,
    XDG_STATE_HOME: `${homeDir}/.local/state`,
    XDG_CACHE_HOME: `${homeDir}/.cache`,
    CODEX_HOME: `${homeDir}/.codex`,
  };
}

export function codexRuntimeDirs(homeDir: string): string[] {
  return [
    `${homeDir}/.codex`,
    `${homeDir}/.codex/skills`,
    `${homeDir}/.local/share/codex`,
    `${homeDir}/.local/state/codex`,
    `${homeDir}/.cache/codex`,
  ];
}

export function opencodeRuntimeDirs(homeDir: string): string[] {
  return [
    `${homeDir}/.config/opencode`,
    `${homeDir}/.local/share/opencode`,
    `${homeDir}/.local/state/opencode`,
    `${homeDir}/.cache/opencode`,
  ];
}

export function claudeCodeRuntimeEnvironment(homeDir: string): Record<string, string> {
  return {
    HOME: homeDir,
    XDG_CONFIG_HOME: `${homeDir}/.config`,
    XDG_DATA_HOME: `${homeDir}/.local/share`,
    XDG_STATE_HOME: `${homeDir}/.local/state`,
    XDG_CACHE_HOME: `${homeDir}/.cache`,
    CLAUDE_CONFIG_DIR: `${homeDir}/.claude`,
  };
}

export function claudeCodeRuntimeDirs(homeDir: string): string[] {
  return [
    `${homeDir}/.claude`,
    `${homeDir}/.claude/projects`,
    `${homeDir}/.local/share/claude`,
    `${homeDir}/.local/state/claude`,
    `${homeDir}/.cache/claude`,
  ];
}
