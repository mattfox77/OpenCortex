export const OPENCODE_PROVIDER_ID = "opencode" as const;
export const PINNED_OPENCODE_VERSION = "1.14.50" as const;

export type WorkbenchProviderId = typeof OPENCODE_PROVIDER_ID;
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
  planLaunch(request: WorkbenchLaunchRequest): WorkbenchLaunchPlan;
}

export class OpenCodeWorkbenchProvider implements WorkbenchProvider {
  readonly id = OPENCODE_PROVIDER_ID;
  readonly version = PINNED_OPENCODE_VERSION;

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

export function opencodeRuntimeDirs(homeDir: string): string[] {
  return [
    `${homeDir}/.config/opencode`,
    `${homeDir}/.local/share/opencode`,
    `${homeDir}/.local/state/opencode`,
    `${homeDir}/.cache/opencode`,
  ];
}
