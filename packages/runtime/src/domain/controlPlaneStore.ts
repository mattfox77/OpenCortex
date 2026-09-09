import {
  accessSync,
  constants as fsConstants,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { nanoid } from "nanoid";
import {
  selectHostForSession,
  type HostSelectionResult,
} from "@opencortex/host-runtime";
import type { AuthenticatedUser } from "../auth/types.js";
import type { CodeSession } from "../code/sessionLauncher.js";

export const localTenantId = "tenant_local";

export type TenantMembershipRole =
  | "owner"
  | "operator"
  | "reviewer"
  | "observer"
  | "class_admin"
  | "teacher"
  | "teaching_assistant"
  | "student"
  | "auditor";

export type ShareMode =
  | "observe"
  | "annotate"
  | "assist"
  | "pair"
  | "takeover"
  | "handoff"
  | "review-only"
  | "replay-only";

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
}

export interface TenantMembership {
  id: string;
  tenantId: string;
  subject: string;
  email: string;
  role: TenantMembershipRole;
  scopes: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AgentTask {
  id: string;
  tenantId: string;
  ownerSubject: string;
  ownerEmail: string;
  title: string;
  description: string;
  status: "active" | "blocked" | "review" | "completed" | "archived";
  cohortId?: string;
  assignmentInstanceId?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface WorkReference {
  id: string;
  tenantId: string;
  taskId: string;
  kind:
    | "jira"
    | "github_issue"
    | "github_pr"
    | "manual"
    | "link"
    | "note"
    | "repository"
    | "file"
    | "artifact";
  externalId?: string;
  url?: string;
  title?: string;
  metadata: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface Workbench {
  id: string;
  tenantId: string;
  taskId: string;
  ownerSubject: string;
  ownerEmail: string;
  linuxUser: string;
  name?: string;
  status:
    "active" | "starting" | "running" | "stopped" | "archived" | "unknown";
  workspaceDir?: string;
  hostId?: string;
  legacySessionId?: string;
  migrationMetadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface ProviderSession {
  id: string;
  tenantId: string;
  workbenchId: string;
  providerId: string;
  providerVersion?: string;
  nativeSessionId?: string;
  status:
    | "active"
    | "running"
    | "idle"
    | "blocked"
    | "completed"
    | "archived"
    | "unknown";
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface HostRecord {
  id: string;
  tenantId: string;
  name: string;
  status: "online" | "stale" | "offline" | "unknown" | "archived";
  labels: string[];
  metadata: Record<string, unknown>;
  driverId?: string;
  driverVersion?: string;
  pathRoots?: string[];
  capacity?: Record<string, unknown>;
  lastHeartbeatAt?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface HostUserCapability {
  id: string;
  tenantId: string;
  hostId: string;
  subject: string;
  email?: string;
  linuxUser: string;
  providers: Array<Record<string, unknown>>;
  tools: Array<Record<string, unknown>>;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Worktree {
  id: string;
  tenantId: string;
  taskId: string;
  hostId?: string;
  repoUrl?: string;
  path: string;
  branch?: string;
  baseRef?: string;
  status: "ready" | "dirty" | "conflicted" | "archived" | "unknown";
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface Cohort {
  id: string;
  tenantId: string;
  name: string;
  status: "active" | "archived";
  metadata: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface CohortEnrollment {
  id: string;
  tenantId: string;
  cohortId: string;
  subject: string;
  email: string;
  role: Extract<
    TenantMembershipRole,
    "class_admin" | "teacher" | "teaching_assistant" | "student" | "auditor"
  >;
  status: "invited" | "active" | "removed";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AssignmentTemplate {
  id: string;
  tenantId: string;
  cohortId?: string;
  title: string;
  objective: string;
  policy: Record<string, unknown>;
  rubric: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

function providerSessionMetadata(session: CodeSession): Record<string, unknown> {
  return {
    legacySessionId: session.id,
    activeThreadId: session.activeThreadId,
    nativeLink: session.urlPath,
    accountContext: {
      kind: "linux-user",
      linuxUser: session.linuxUser,
      ownerEmail: session.ownerEmail,
    },
    state: {
      source: session.openCodeSessionId ? "provider" : "process",
      observedAt: session.createdAt,
      confidence: session.openCodeSessionId ? "authoritative" : "inferred",
    },
  };
}

function enrichProviderSession(
  providerSession: ProviderSession,
  session: CodeSession,
  observedAt: string,
): void {
  providerSession.providerId = session.providerId ?? providerSession.providerId;
  providerSession.providerVersion =
    session.providerVersion ?? providerSession.providerVersion;
  const nativeSessionId =
    session.openCodeSessionId ?? providerSession.nativeSessionId;
  providerSession.nativeSessionId = nativeSessionId;
  providerSession.status = nativeSessionId
    ? "active"
    : providerSessionStatus(session);
  providerSession.metadata = {
    ...providerSession.metadata,
    ...providerSessionMetadata({ ...session, createdAt: observedAt }),
  };
  providerSession.updatedAt = observedAt;
}

function providerSessionStatus(session: CodeSession): ProviderSession["status"] {
  if (session.openCodeSessionId) {
    return "active";
  }
  return session.mode === "dry-run" ? "unknown" : "running";
}

export interface AssignmentInstance {
  id: string;
  tenantId: string;
  templateId: string;
  cohortId?: string;
  taskId?: string;
  assignee: string;
  assigneeEmail: string;
  status:
    | "assigned"
    | "in_progress"
    | "submitted"
    | "reviewed"
    | "returned"
    | "archived";
  dueAt?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SessionShareGrant {
  id: string;
  tenantId: string;
  workbenchId: string;
  grantee: string;
  mode: ShareMode;
  status: "pending" | "active" | "revoked" | "expired";
  reason?: string;
  createdBy: string;
  createdAt: string;
  expiresAt?: string;
}

interface ControlPlaneState {
  tenants: Tenant[];
  memberships: TenantMembership[];
  tasks: AgentTask[];
  workReferences: WorkReference[];
  workbenches: Workbench[];
  providerSessions: ProviderSession[];
  hosts: HostRecord[];
  hostUserCapabilities: HostUserCapability[];
  worktrees: Worktree[];
  cohorts: Cohort[];
  cohortEnrollments: CohortEnrollment[];
  assignmentTemplates: AssignmentTemplate[];
  assignmentInstances: AssignmentInstance[];
  sessionShareGrants: SessionShareGrant[];
}

export interface LegacyControlPlaneIds {
  tenantId: string;
  taskId: string;
  workbenchId: string;
  providerSessionId: string;
}

export class ControlPlaneStore {
  private readonly filePath: string;
  private readonly state: ControlPlaneState;
  private persistent = false;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "control-plane.json");
    this.persistent = this.ensureWritable(dataDir);
    this.state = this.readFromDisk();
    this.ensureLocalTenant();
    this.persist();
  }

  ensureUserMembership(user: AuthenticatedUser): TenantMembership {
    const existing = this.state.memberships.find(
      (item) => item.tenantId === localTenantId && item.subject === user.sub,
    );
    if (existing) {
      return existing;
    }
    const now = new Date().toISOString();
    const membership: TenantMembership = {
      id: `membership_${nanoid(12)}`,
      tenantId: localTenantId,
      subject: user.sub,
      email: user.email,
      role: user.isSuperAdmin ? "owner" : "operator",
      scopes: {},
      createdAt: now,
      updatedAt: now,
    };
    this.state.memberships.push(membership);
    this.persist();
    return membership;
  }

  ensureLegacySession(session: CodeSession): LegacyControlPlaneIds {
    const tenantId = session.tenantId ?? localTenantId;
    this.ensureLocalTenant();
    const now = new Date().toISOString();
    const task =
      this.state.tasks.find(
        (item) =>
          item.tenantId === tenantId &&
          item.metadata.legacySessionId === session.id,
      ) ??
      this.createTaskRecord({
        tenantId,
        ownerSubject: session.ownerSubject ?? `legacy:${session.ownerEmail}`,
        ownerEmail: session.ownerEmail,
        title: session.name ?? `Workbench ${session.id}`,
        description:
          "Imported from legacy code-sessions.json compatibility data.",
        metadata: {
          legacySessionId: session.id,
          legacySource: "code-sessions.json",
        },
        now,
      });
    const workbench =
      this.state.workbenches.find(
        (item) =>
          item.tenantId === tenantId && item.legacySessionId === session.id,
      ) ??
      this.createWorkbenchRecord({
        tenantId,
        taskId: task.id,
        ownerSubject: session.ownerSubject ?? task.ownerSubject,
        ownerEmail: session.ownerEmail,
        linuxUser: session.linuxUser,
        name: session.name,
        status: session.mode === "dry-run" ? "unknown" : "running",
        workspaceDir: session.workspaceDir,
        legacySessionId: session.id,
        migrationMetadata: {
          legacySessionId: session.id,
          urlPath: session.urlPath,
          port: session.port,
          command: session.command,
          mode: session.mode,
          threads: session.threads ?? [],
        },
        now,
      });
    const provider =
      this.state.providerSessions.find(
        (item) =>
          item.tenantId === tenantId &&
          item.workbenchId === workbench.id &&
          item.metadata.legacySessionId === session.id,
      ) ??
      this.createProviderSessionRecord({
        tenantId,
        workbenchId: workbench.id,
        providerId: session.providerId ?? "opencode",
        providerVersion: session.providerVersion,
        nativeSessionId: session.openCodeSessionId,
        status: providerSessionStatus(session),
        metadata: providerSessionMetadata(session),
        now,
      });
    enrichProviderSession(provider, session, now);

    const changed =
      session.tenantId !== tenantId ||
      session.taskId !== task.id ||
      session.workbenchId !== workbench.id ||
      session.providerSessionId !== provider.id ||
      session.ownerSubject !== task.ownerSubject;
    if (changed) {
      session.tenantId = tenantId;
      session.taskId = task.id;
      session.workbenchId = workbench.id;
      session.providerSessionId = provider.id;
      session.ownerSubject = task.ownerSubject;
    }
    this.persist();
    return {
      tenantId,
      taskId: task.id,
      workbenchId: workbench.id,
      providerSessionId: provider.id,
    };
  }

  listTasks(user: AuthenticatedUser, limit = 50): AgentTask[] {
    this.ensureUserMembership(user);
    return this.state.tasks
      .filter((task) => this.canReadTask(user, task))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  getTask(user: AuthenticatedUser, id: string): AgentTask | undefined {
    const task = this.state.tasks.find((item) => item.id === id);
    return task && this.canReadTask(user, task) ? task : undefined;
  }

  createTask(input: {
    user: AuthenticatedUser;
    title: string;
    description?: string;
    cohortId?: string;
    assignmentInstanceId?: string;
  }): AgentTask {
    this.ensureUserMembership(input.user);
    const now = new Date().toISOString();
    const task = this.createTaskRecord({
      tenantId: localTenantId,
      ownerSubject: input.user.sub,
      ownerEmail: input.user.email,
      title: input.title,
      description: input.description ?? "",
      cohortId: input.cohortId,
      assignmentInstanceId: input.assignmentInstanceId,
      metadata: {},
      now,
    });
    this.persist();
    return task;
  }

  archiveTask(user: AuthenticatedUser, id: string): AgentTask | undefined {
    const task = this.getTask(user, id);
    if (!task || !this.canOperate(user, task.ownerEmail)) {
      return undefined;
    }
    const now = new Date().toISOString();
    task.status = "archived";
    task.archivedAt = now;
    task.updatedAt = now;
    this.persist();
    return task;
  }

  createWorkReference(input: {
    user: AuthenticatedUser;
    taskId: string;
    kind: WorkReference["kind"];
    externalId?: string;
    url?: string;
    title?: string;
    metadata?: Record<string, unknown>;
  }): WorkReference | undefined {
    const task = this.getTask(input.user, input.taskId);
    if (!task || !this.canOperate(input.user, task.ownerEmail)) {
      return undefined;
    }
    const now = new Date().toISOString();
    const reference: WorkReference = {
      id: `ref_${nanoid(12)}`,
      tenantId: task.tenantId,
      taskId: task.id,
      kind: input.kind,
      externalId: input.externalId,
      url: input.url,
      title: input.title,
      metadata: input.metadata ?? {},
      createdBy: input.user.sub,
      createdAt: now,
      updatedAt: now,
    };
    this.state.workReferences.push(reference);
    this.persist();
    return reference;
  }

  listWorkReferences(
    user: AuthenticatedUser,
    taskId: string,
  ): WorkReference[] | undefined {
    const task = this.getTask(user, taskId);
    if (!task) {
      return undefined;
    }
    return this.state.workReferences.filter(
      (item) =>
        item.tenantId === task.tenantId &&
        item.taskId === task.id &&
        !item.archivedAt,
    );
  }

  listWorkbenches(user: AuthenticatedUser, limit = 50): Workbench[] {
    this.ensureUserMembership(user);
    return this.state.workbenches
      .filter((workbench) => this.canReadWorkbench(user, workbench))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  getWorkbench(user: AuthenticatedUser, id: string): Workbench | undefined {
    const workbench = this.state.workbenches.find((item) => item.id === id);
    return workbench && this.canReadWorkbench(user, workbench)
      ? workbench
      : undefined;
  }

  createWorkbench(input: {
    user: AuthenticatedUser;
    taskId: string;
    name?: string;
    workspaceDir?: string;
  }): Workbench | undefined {
    const task = this.getTask(input.user, input.taskId);
    if (!task || !this.canOperate(input.user, task.ownerEmail)) {
      return undefined;
    }
    const now = new Date().toISOString();
    const workbench = this.createWorkbenchRecord({
      tenantId: task.tenantId,
      taskId: task.id,
      ownerSubject: input.user.sub,
      ownerEmail: input.user.email,
      linuxUser: input.user.linuxUser,
      name: input.name,
      status: "active",
      workspaceDir: input.workspaceDir,
      migrationMetadata: {},
      now,
    });
    this.persist();
    return workbench;
  }

  listProviderSessions(
    user: AuthenticatedUser,
    workbenchId: string,
  ): ProviderSession[] | undefined {
    const workbench = this.getWorkbench(user, workbenchId);
    if (!workbench) {
      return undefined;
    }
    return this.state.providerSessions.filter(
      (item) =>
        item.tenantId === workbench.tenantId &&
      item.workbenchId === workbench.id,
    );
  }

  registerHost(input: {
    user: AuthenticatedUser;
    id?: string;
    name: string;
    labels?: string[];
    driverId?: string;
    driverVersion?: string;
    pathRoots?: string[];
    capacity?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    status?: HostRecord["status"];
  }): HostRecord {
    this.ensureUserMembership(input.user);
    const now = new Date().toISOString();
    const id = input.id ?? `host_${nanoid(12)}`;
    const existing = this.state.hosts.find((item) => item.id === id);
    if (existing) {
      existing.name = input.name;
      existing.status = input.status ?? "online";
      existing.labels = input.labels ?? existing.labels;
      existing.driverId = input.driverId ?? existing.driverId;
      existing.driverVersion = input.driverVersion ?? existing.driverVersion;
      existing.pathRoots = input.pathRoots ?? existing.pathRoots;
      existing.capacity = input.capacity ?? existing.capacity;
      existing.metadata = { ...existing.metadata, ...(input.metadata ?? {}) };
      existing.lastHeartbeatAt = now;
      existing.updatedAt = now;
      this.persist();
      return existing;
    }
    const host: HostRecord = {
      id,
      tenantId: localTenantId,
      name: input.name,
      status: input.status ?? "online",
      labels: input.labels ?? [],
      metadata: input.metadata ?? {},
      driverId: input.driverId,
      driverVersion: input.driverVersion,
      pathRoots: input.pathRoots,
      capacity: input.capacity,
      lastHeartbeatAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.state.hosts.push(host);
    this.persist();
    return host;
  }

  heartbeatHost(
    user: AuthenticatedUser,
    hostId: string,
    input: {
      status?: HostRecord["status"];
      labels?: string[];
      driverId?: string;
      driverVersion?: string;
      pathRoots?: string[];
      capacity?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    } = {},
  ): HostRecord | undefined {
    this.ensureUserMembership(user);
    const host = this.state.hosts.find((item) => item.id === hostId);
    if (!host || host.status === "archived") {
      return undefined;
    }
    const now = new Date().toISOString();
    host.status = input.status ?? "online";
    host.labels = input.labels ?? host.labels;
    host.driverId = input.driverId ?? host.driverId;
    host.driverVersion = input.driverVersion ?? host.driverVersion;
    host.pathRoots = input.pathRoots ?? host.pathRoots;
    host.capacity = input.capacity ?? host.capacity;
    host.metadata = { ...host.metadata, ...(input.metadata ?? {}) };
    host.lastHeartbeatAt = now;
    host.updatedAt = now;
    this.persist();
    return host;
  }

  listHosts(user: AuthenticatedUser): HostRecord[] {
    this.ensureUserMembership(user);
    return this.state.hosts
      .filter((host) => host.status !== "archived")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  upsertHostUserCapability(input: {
    user: AuthenticatedUser;
    hostId: string;
    subject: string;
    email?: string;
    linuxUser: string;
    providers?: Array<Record<string, unknown>>;
    tools?: Array<Record<string, unknown>>;
    metadata?: Record<string, unknown>;
  }): HostUserCapability | undefined {
    this.ensureUserMembership(input.user);
    const host = this.state.hosts.find((item) => item.id === input.hostId);
    if (!host || host.status === "archived") {
      return undefined;
    }
    const now = new Date().toISOString();
    const existing = this.state.hostUserCapabilities.find(
      (item) =>
        item.hostId === host.id &&
        item.subject === input.subject &&
        item.linuxUser === input.linuxUser,
    );
    if (existing) {
      existing.email = input.email ?? existing.email;
      existing.providers = input.providers ?? existing.providers;
      existing.tools = input.tools ?? existing.tools;
      existing.metadata = { ...existing.metadata, ...(input.metadata ?? {}) };
      existing.updatedAt = now;
      this.persist();
      return existing;
    }
    const capability: HostUserCapability = {
      id: `host_user_capability_${nanoid(12)}`,
      tenantId: host.tenantId,
      hostId: host.id,
      subject: input.subject,
      email: input.email,
      linuxUser: input.linuxUser,
      providers: input.providers ?? [],
      tools: input.tools ?? [],
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.state.hostUserCapabilities.push(capability);
    this.persist();
    return capability;
  }

  listHostUserCapabilities(
    user: AuthenticatedUser,
    hostId?: string,
  ): HostUserCapability[] {
    this.ensureUserMembership(user);
    return this.state.hostUserCapabilities
      .filter((capability) => {
        if (hostId && capability.hostId !== hostId) {
          return false;
        }
        return user.isSuperAdmin || capability.subject === user.sub;
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  selectHost(input: {
    user: AuthenticatedUser;
    linuxUser?: string;
    providerId: string;
    explicitHostId?: string;
    requiredLabels?: string[];
    repositoryPath?: string;
  }): HostSelectionResult {
    this.ensureUserMembership(input.user);
    return selectHostForSession(
      this.state.hosts
        .filter((host) => host.status !== "archived")
        .map((host) => ({
          id: host.id,
          status: host.status,
          labels: host.labels,
          capacity: normalizeHostCapacity(host.capacity),
          pathRoots: host.pathRoots,
          capabilities: this.state.hostUserCapabilities
            .filter(
              (capability) =>
                capability.hostId === host.id &&
                capability.tenantId === host.tenantId &&
                capability.subject === input.user.sub,
            )
            .map((capability) => ({
              subject: capability.subject,
              linuxUser: capability.linuxUser,
              providers: capability.providers.map(normalizeProviderCapability),
            })),
        })),
      {
        subject: input.user.sub,
        linuxUser: input.linuxUser ?? input.user.linuxUser,
        providerId: input.providerId,
        explicitHostId: input.explicitHostId,
        requiredLabels: input.requiredLabels,
        repositoryPath: input.repositoryPath,
      },
    );
  }

  createWorktree(input: {
    user: AuthenticatedUser;
    taskId: string;
    hostId?: string;
    repoUrl?: string;
    path: string;
    branch?: string;
    baseRef?: string;
    status?: Worktree["status"];
    metadata?: Record<string, unknown>;
  }): Worktree | undefined {
    const task = this.getTask(input.user, input.taskId);
    if (!task) {
      return undefined;
    }
    const host = input.hostId
      ? this.state.hosts.find((item) => item.id === input.hostId)
      : undefined;
    if (input.hostId && (!host || host.status === "archived")) {
      return undefined;
    }
    const resolvedPath = host?.pathRoots?.length
      ? assertPathWithinRoots(input.path, host.pathRoots)
      : resolve(input.path);
    const now = new Date().toISOString();
    const existing = this.state.worktrees.find(
      (item) =>
        item.taskId === task.id &&
        item.path === resolvedPath &&
        item.status !== "archived",
    );
    if (existing) {
      return existing;
    }
    const worktree: Worktree = {
      id: `worktree_${nanoid(12)}`,
      tenantId: task.tenantId,
      taskId: task.id,
      hostId: input.hostId,
      repoUrl: input.repoUrl,
      path: resolvedPath,
      branch: input.branch,
      baseRef: input.baseRef,
      status: input.status ?? "unknown",
      metadata: {
        ...(input.metadata ?? {}),
        provenance: {
          requestedPath: input.path,
          resolvedPath,
          repoUrl: input.repoUrl,
          branch: input.branch,
          baseRef: input.baseRef,
          hostId: input.hostId,
        },
      },
      createdAt: now,
      updatedAt: now,
    };
    this.state.worktrees.push(worktree);
    this.persist();
    return worktree;
  }

  listWorktrees(
    user: AuthenticatedUser,
    taskId?: string,
  ): Worktree[] | undefined {
    if (taskId && !this.getTask(user, taskId)) {
      return undefined;
    }
    this.ensureUserMembership(user);
    return this.state.worktrees
      .filter((worktree) => {
        if (taskId && worktree.taskId !== taskId) {
          return false;
        }
        const task = this.state.tasks.find(
          (item) => item.id === worktree.taskId,
        );
        return Boolean(task && this.canReadTask(user, task));
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  createCohort(input: {
    user: AuthenticatedUser;
    name: string;
    metadata?: Record<string, unknown>;
  }): Cohort {
    this.ensureUserMembership(input.user);
    const now = new Date().toISOString();
    const cohort: Cohort = {
      id: `cohort_${nanoid(12)}`,
      tenantId: localTenantId,
      name: input.name,
      status: "active",
      metadata: input.metadata ?? {},
      createdBy: input.user.sub,
      createdAt: now,
      updatedAt: now,
    };
    this.state.cohorts.push(cohort);
    this.state.cohortEnrollments.push({
      id: `enrollment_${nanoid(12)}`,
      tenantId: cohort.tenantId,
      cohortId: cohort.id,
      subject: input.user.sub,
      email: input.user.email,
      role: "teacher",
      status: "active",
      createdBy: input.user.sub,
      createdAt: now,
      updatedAt: now,
    });
    this.persist();
    return cohort;
  }

  listCohorts(user: AuthenticatedUser): Cohort[] {
    this.ensureUserMembership(user);
    return this.state.cohorts
      .filter((cohort) => this.canReadCohort(user, cohort))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getCohort(user: AuthenticatedUser, id: string): Cohort | undefined {
    const cohort = this.state.cohorts.find((item) => item.id === id);
    return cohort && this.canReadCohort(user, cohort) ? cohort : undefined;
  }

  addEnrollment(input: {
    user: AuthenticatedUser;
    cohortId: string;
    email: string;
    role: CohortEnrollment["role"];
    subject?: string;
  }): CohortEnrollment | undefined {
    const cohort = this.getCohort(input.user, input.cohortId);
    if (!cohort || !this.canManageCohort(input.user, cohort)) {
      return undefined;
    }
    const subject = input.subject ?? `email:${input.email.toLowerCase()}`;
    const existing = this.state.cohortEnrollments.find(
      (item) =>
        item.cohortId === cohort.id &&
        item.subject === subject &&
        item.role === input.role,
    );
    if (existing) {
      return existing;
    }
    const now = new Date().toISOString();
    const enrollment: CohortEnrollment = {
      id: `enrollment_${nanoid(12)}`,
      tenantId: cohort.tenantId,
      cohortId: cohort.id,
      subject,
      email: input.email.toLowerCase(),
      role: input.role,
      status: "active",
      createdBy: input.user.sub,
      createdAt: now,
      updatedAt: now,
    };
    this.state.cohortEnrollments.push(enrollment);
    this.persist();
    return enrollment;
  }

  listEnrollments(
    user: AuthenticatedUser,
    cohortId: string,
  ): CohortEnrollment[] | undefined {
    const cohort = this.getCohort(user, cohortId);
    if (!cohort) {
      return undefined;
    }
    if (this.canManageCohort(user, cohort) || user.isSuperAdmin) {
      return this.state.cohortEnrollments.filter(
        (item) => item.cohortId === cohort.id,
      );
    }
    return this.state.cohortEnrollments.filter(
      (item) => item.cohortId === cohort.id && item.subject === user.sub,
    );
  }

  createAssignmentTemplate(input: {
    user: AuthenticatedUser;
    cohortId?: string;
    title: string;
    objective?: string;
    policy?: Record<string, unknown>;
    rubric?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }): AssignmentTemplate | undefined {
    if (input.cohortId) {
      const cohort = this.getCohort(input.user, input.cohortId);
      if (!cohort || !this.canManageCohort(input.user, cohort)) {
        return undefined;
      }
    }
    const now = new Date().toISOString();
    const template: AssignmentTemplate = {
      id: `assignment_template_${nanoid(12)}`,
      tenantId: localTenantId,
      cohortId: input.cohortId,
      title: input.title,
      objective: input.objective ?? "",
      policy: input.policy ?? {},
      rubric: input.rubric ?? {},
      metadata: input.metadata ?? {},
      createdBy: input.user.sub,
      createdAt: now,
      updatedAt: now,
    };
    this.state.assignmentTemplates.push(template);
    this.persist();
    return template;
  }

  listAssignmentTemplates(user: AuthenticatedUser): AssignmentTemplate[] {
    this.ensureUserMembership(user);
    return this.state.assignmentTemplates
      .filter((template) => this.canReadAssignmentTemplate(user, template))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  createAssignmentInstance(input: {
    user: AuthenticatedUser;
    templateId: string;
    assignee: string;
    assigneeEmail: string;
    dueAt?: string;
    taskId?: string;
    metadata?: Record<string, unknown>;
  }): AssignmentInstance | undefined {
    const template = this.state.assignmentTemplates.find(
      (item) => item.id === input.templateId,
    );
    if (!template || !this.canManageAssignmentTemplate(input.user, template)) {
      return undefined;
    }
    if (input.taskId) {
      const task = this.getTask(input.user, input.taskId);
      if (!task) {
        return undefined;
      }
    }
    const existing = this.state.assignmentInstances.find(
      (item) =>
        item.templateId === template.id &&
        item.assignee === input.assignee &&
        item.status !== "archived",
    );
    if (existing) {
      return existing;
    }
    const now = new Date().toISOString();
    const instance: AssignmentInstance = {
      id: `assignment_instance_${nanoid(12)}`,
      tenantId: template.tenantId,
      templateId: template.id,
      cohortId: template.cohortId,
      taskId: input.taskId,
      assignee: input.assignee,
      assigneeEmail: input.assigneeEmail.toLowerCase(),
      status: "assigned",
      dueAt: input.dueAt,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.state.assignmentInstances.push(instance);
    this.persist();
    return instance;
  }

  listAssignmentInstances(
    user: AuthenticatedUser,
    templateId: string,
  ): AssignmentInstance[] | undefined {
    this.ensureUserMembership(user);
    const template = this.state.assignmentTemplates.find(
      (item) => item.id === templateId,
    );
    if (!template) {
      return undefined;
    }
    if (this.canManageAssignmentTemplate(user, template)) {
      return this.state.assignmentInstances
        .filter((item) => item.templateId === template.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    if (!this.canReadAssignmentTemplate(user, template)) {
      return undefined;
    }
    return this.state.assignmentInstances
      .filter(
        (item) => item.templateId === template.id && item.assignee === user.sub,
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  createSessionShareGrant(input: {
    user: AuthenticatedUser;
    workbenchId: string;
    grantee: string;
    mode: ShareMode;
    reason?: string;
  }): SessionShareGrant | undefined {
    const workbench = this.getWorkbench(input.user, input.workbenchId);
    if (!workbench || !this.canOperate(input.user, workbench.ownerEmail)) {
      return undefined;
    }
    const now = new Date().toISOString();
    const grant: SessionShareGrant = {
      id: `share_${nanoid(12)}`,
      tenantId: workbench.tenantId,
      workbenchId: workbench.id,
      grantee: input.grantee,
      mode: input.mode,
      status: "active",
      reason: input.reason,
      createdBy: input.user.sub,
      createdAt: now,
    };
    this.state.sessionShareGrants.push(grant);
    this.persist();
    return grant;
  }

  listSessionShareGrants(
    user: AuthenticatedUser,
    workbenchId?: string,
  ): SessionShareGrant[] {
    return this.state.sessionShareGrants
      .filter((grant) => {
        if (workbenchId && grant.workbenchId !== workbenchId) {
          return false;
        }
        const workbench = this.state.workbenches.find(
          (item) => item.id === grant.workbenchId,
        );
        if (!workbench) {
          return false;
        }
        return (
          this.canReadWorkbench(user, workbench) || grant.grantee === user.sub
        );
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private canReadTask(user: AuthenticatedUser, task: AgentTask): boolean {
    return user.isSuperAdmin === true || task.ownerEmail === user.email;
  }

  private canReadWorkbench(
    user: AuthenticatedUser,
    workbench: Workbench,
  ): boolean {
    if (user.isSuperAdmin === true || workbench.ownerEmail === user.email) {
      return true;
    }
    return this.state.sessionShareGrants.some(
      (grant) =>
        grant.workbenchId === workbench.id &&
        grant.status === "active" &&
        grant.grantee === user.sub,
    );
  }

  private canOperate(user: AuthenticatedUser, ownerEmail: string): boolean {
    return user.isSuperAdmin === true || user.email === ownerEmail;
  }

  private canReadCohort(user: AuthenticatedUser, cohort: Cohort): boolean {
    return (
      user.isSuperAdmin === true ||
      this.state.cohortEnrollments.some(
        (item) =>
          item.cohortId === cohort.id &&
          item.status === "active" &&
          item.subject === user.sub,
      )
    );
  }

  private canManageCohort(user: AuthenticatedUser, cohort: Cohort): boolean {
    return (
      user.isSuperAdmin === true ||
      this.state.cohortEnrollments.some(
        (item) =>
          item.cohortId === cohort.id &&
          item.status === "active" &&
          item.subject === user.sub &&
          ["class_admin", "teacher", "teaching_assistant"].includes(item.role),
      )
    );
  }

  private canReadAssignmentTemplate(
    user: AuthenticatedUser,
    template: AssignmentTemplate,
  ): boolean {
    if (user.isSuperAdmin || template.createdBy === user.sub) {
      return true;
    }
    if (!template.cohortId) {
      return this.state.assignmentInstances.some(
        (item) => item.templateId === template.id && item.assignee === user.sub,
      );
    }
    const cohort = this.state.cohorts.find(
      (item) => item.id === template.cohortId,
    );
    return Boolean(cohort && this.canReadCohort(user, cohort));
  }

  private canManageAssignmentTemplate(
    user: AuthenticatedUser,
    template: AssignmentTemplate,
  ): boolean {
    if (user.isSuperAdmin || template.createdBy === user.sub) {
      return true;
    }
    if (!template.cohortId) {
      return false;
    }
    const cohort = this.state.cohorts.find(
      (item) => item.id === template.cohortId,
    );
    return Boolean(cohort && this.canManageCohort(user, cohort));
  }

  private createTaskRecord(input: {
    tenantId: string;
    ownerSubject: string;
    ownerEmail: string;
    title: string;
    description: string;
    cohortId?: string;
    assignmentInstanceId?: string;
    metadata: Record<string, unknown>;
    now: string;
  }): AgentTask {
    const task: AgentTask = {
      id: `task_${nanoid(12)}`,
      tenantId: input.tenantId,
      ownerSubject: input.ownerSubject,
      ownerEmail: input.ownerEmail,
      title: input.title,
      description: input.description,
      status: "active",
      cohortId: input.cohortId,
      assignmentInstanceId: input.assignmentInstanceId,
      metadata: input.metadata,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.state.tasks.push(task);
    return task;
  }

  private createWorkbenchRecord(input: {
    tenantId: string;
    taskId: string;
    ownerSubject: string;
    ownerEmail: string;
    linuxUser: string;
    name?: string;
    status: Workbench["status"];
    workspaceDir?: string;
    hostId?: string;
    legacySessionId?: string;
    migrationMetadata: Record<string, unknown>;
    now: string;
  }): Workbench {
    const workbench: Workbench = {
      id: `workbench_${nanoid(12)}`,
      tenantId: input.tenantId,
      taskId: input.taskId,
      ownerSubject: input.ownerSubject,
      ownerEmail: input.ownerEmail,
      linuxUser: input.linuxUser,
      name: input.name,
      status: input.status,
      workspaceDir: input.workspaceDir,
      hostId: input.hostId,
      legacySessionId: input.legacySessionId,
      migrationMetadata: input.migrationMetadata,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.state.workbenches.push(workbench);
    return workbench;
  }

  private createProviderSessionRecord(input: {
    tenantId: string;
    workbenchId: string;
    providerId: string;
    providerVersion?: string;
    nativeSessionId?: string;
    status: ProviderSession["status"];
    metadata: Record<string, unknown>;
    now: string;
  }): ProviderSession {
    const providerSession: ProviderSession = {
      id: `provider_session_${nanoid(12)}`,
      tenantId: input.tenantId,
      workbenchId: input.workbenchId,
      providerId: input.providerId,
      providerVersion: input.providerVersion,
      nativeSessionId: input.nativeSessionId,
      status: input.status,
      metadata: input.metadata,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.state.providerSessions.push(providerSession);
    return providerSession;
  }

  private ensureLocalTenant(): void {
    if (this.state.tenants.some((tenant) => tenant.id === localTenantId)) {
      return;
    }
    const now = new Date().toISOString();
    this.state.tenants.push({
      id: localTenantId,
      slug: "local",
      name: "Local OpenCortex",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  }

  private readFromDisk(): ControlPlaneState {
    try {
      const parsed = JSON.parse(
        readFileSync(this.filePath, "utf8"),
      ) as Partial<ControlPlaneState>;
      return {
        tenants: parsed.tenants ?? [],
        memberships: parsed.memberships ?? [],
        tasks: parsed.tasks ?? [],
        workReferences: parsed.workReferences ?? [],
        workbenches: parsed.workbenches ?? [],
        providerSessions: parsed.providerSessions ?? [],
        hosts: parsed.hosts ?? [],
        hostUserCapabilities: parsed.hostUserCapabilities ?? [],
        worktrees: parsed.worktrees ?? [],
        cohorts: parsed.cohorts ?? [],
        cohortEnrollments: parsed.cohortEnrollments ?? [],
        assignmentTemplates: parsed.assignmentTemplates ?? [],
        assignmentInstances: parsed.assignmentInstances ?? [],
        sessionShareGrants: parsed.sessionShareGrants ?? [],
      };
    } catch {
      return {
        tenants: [],
        memberships: [],
        tasks: [],
        workReferences: [],
        workbenches: [],
        providerSessions: [],
        hosts: [],
        hostUserCapabilities: [],
        worktrees: [],
        cohorts: [],
        cohortEnrollments: [],
        assignmentTemplates: [],
        assignmentInstances: [],
        sessionShareGrants: [],
      };
    }
  }

  private ensureWritable(dataDir: string): boolean {
    try {
      mkdirSync(dataDir, { recursive: true });
      accessSync(dataDir, fsConstants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  private persist(): void {
    if (!this.persistent) {
      return;
    }
    writeFileSync(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`, {
      encoding: "utf8",
    });
  }
}

function normalizeHostCapacity(
  capacity: Record<string, unknown> | undefined,
):
  | {
      availableSessions?: number;
      maxSessions?: number;
    }
  | undefined {
  if (!capacity) {
    return undefined;
  }
  return {
    availableSessions: numberRecordField(capacity, [
      "availableSessions",
      "available_sessions",
      "sessions",
    ]),
    maxSessions: numberRecordField(capacity, [
      "maxSessions",
      "max_sessions",
      "sessions",
    ]),
  };
}

function normalizeProviderCapability(
  provider: Record<string, unknown>,
): { providerId: string; ready: boolean } {
  return {
    providerId: stringRecordField(provider, ["providerId", "provider_id"], ""),
    ready: provider.ready === true,
  };
}

function numberRecordField(
  object: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function stringRecordField(
  object: Record<string, unknown>,
  keys: string[],
  fallback: string,
): string {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return fallback;
}

export function assertPathWithinRoots(path: string, roots: string[]): string {
  if (roots.length === 0) {
    throw new Error("At least one path root is required");
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
    throw new Error(`Path escapes allowed roots: ${path}`);
  }
  return resolvedPath;
}
