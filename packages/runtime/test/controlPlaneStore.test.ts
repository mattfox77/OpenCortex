import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ControlPlaneStore } from '../src/domain/controlPlaneStore.js';
import type { AuthenticatedUser } from '../src/auth/types.js';
import type { CodeSession } from '../src/code/sessionLauncher.js';

function user(email = 'owner@acme.test'): AuthenticatedUser {
  const local = email.split('@')[0];
  return {
    sub: `dev:${email}`,
    email,
    groups: ['OpenCodeUsers'],
    linuxUser: local,
  };
}

function superAdmin(email = 'admin@acme.test'): AuthenticatedUser {
  return {
    ...user(email),
    isSuperAdmin: true,
  };
}

function session(overrides: Partial<CodeSession> = {}): CodeSession {
  return {
    id: 'workspace-owner',
    ownerEmail: 'owner@acme.test',
    ownerSubject: 'dev:owner@acme.test',
    linuxUser: 'owner',
    createdAt: '2026-09-07T00:00:00.000Z',
    workspaceDir: '/home/owner/repos',
    port: 4873,
    urlPath: '/diwan/code/session/workspace-owner/',
    command: ['opencode', 'web'],
    mode: 'dry-run',
    providerId: 'opencode',
    providerVersion: 'test',
    openCodeSessionId: 'opencode-session-1',
    ...overrides,
  };
}

function store(): ControlPlaneStore {
  return new ControlPlaneStore(mkdtempSync(join(tmpdir(), 'opencortex-cp-')));
}

describe('ControlPlaneStore', () => {
  it('imports a legacy code session idempotently and stamps canonical ids', () => {
    const controlPlane = store();
    const legacy = session();

    const first = controlPlane.ensureLegacySession(legacy);
    const second = controlPlane.ensureLegacySession(legacy);

    expect(second).toEqual(first);
    expect(legacy.taskId).toBe(first.taskId);
    expect(legacy.workbenchId).toBe(first.workbenchId);
    expect(legacy.providerSessionId).toBe(first.providerSessionId);

    expect(controlPlane.listTasks(user())).toHaveLength(1);
    expect(controlPlane.listWorkbenches(user())).toHaveLength(1);
    expect(
      controlPlane.listProviderSessions(user(), first.workbenchId),
    ).toHaveLength(1);
  });

  it('keeps owner-scoped tasks and workbenches isolated from other users', () => {
    const controlPlane = store();
    const owner = user('owner@acme.test');
    const other = user('other@acme.test');
    const task = controlPlane.createTask({
      user: owner,
      title: 'Implement task',
    });
    const workbench = controlPlane.createWorkbench({
      user: owner,
      taskId: task.id,
      name: 'first workbench',
    });

    expect(workbench).toBeDefined();
    expect(controlPlane.listTasks(owner).map(item => item.id)).toEqual([
      task.id,
    ]);
    expect(controlPlane.listTasks(other)).toEqual([]);
    expect(controlPlane.getTask(other, task.id)).toBeUndefined();
    expect(controlPlane.getWorkbench(other, workbench!.id)).toBeUndefined();
    expect(controlPlane.getTask(superAdmin(), task.id)?.id).toBe(task.id);
  });

  it('allows multiple workbenches for one user and one task', () => {
    const controlPlane = store();
    const owner = user();
    const task = controlPlane.createTask({ user: owner, title: 'Parallel work' });

    const first = controlPlane.createWorkbench({
      user: owner,
      taskId: task.id,
      name: 'Implementation',
    });
    const second = controlPlane.createWorkbench({
      user: owner,
      taskId: task.id,
      name: 'Review',
    });

    expect(first?.id).toMatch(/^workbench_/);
    expect(second?.id).toMatch(/^workbench_/);
    expect(first?.id).not.toBe(second?.id);
    expect(controlPlane.listWorkbenches(owner).map(item => item.id).sort()).toEqual(
      [first!.id, second!.id].sort(),
    );
  });

  it('tracks host capabilities and refuses worktrees outside host roots', () => {
    const controlPlane = store();
    const owner = user('owner@acme.test');
    const host = controlPlane.registerHost({
      user: owner,
      id: 'linux-macbook',
      name: 'linux-macbook',
      labels: ['fedora', 'tailscale'],
      driverId: 'direct-process',
      driverVersion: '0.1.0',
      pathRoots: ['/home/owner/repos'],
    });
    expect(host.status).toBe('online');

    const capability = controlPlane.upsertHostUserCapability({
      user: owner,
      hostId: host.id,
      subject: owner.sub,
      email: owner.email,
      linuxUser: owner.linuxUser,
      providers: [{ providerId: 'opencode', ready: true }],
    });
    expect(capability?.providers).toEqual([
      { providerId: 'opencode', ready: true },
    ]);

    const task = controlPlane.createTask({ user: owner, title: 'Worktree task' });
    const worktree = controlPlane.createWorktree({
      user: owner,
      taskId: task.id,
      hostId: host.id,
      repoUrl: 'https://github.com/mattfox77/OpenCortex.git',
      path: '/home/owner/repos/OpenCortex',
      branch: 'slice-2',
      baseRef: 'origin/main',
      status: 'ready',
    });
    expect(worktree?.status).toBe('ready');
    expect(worktree?.path).toBe('/home/owner/repos/OpenCortex');
    expect(worktree?.metadata.provenance).toEqual({
      requestedPath: '/home/owner/repos/OpenCortex',
      resolvedPath: '/home/owner/repos/OpenCortex',
      repoUrl: 'https://github.com/mattfox77/OpenCortex.git',
      branch: 'slice-2',
      baseRef: 'origin/main',
      hostId: host.id,
    });
    expect(
      controlPlane.selectHost({
        user: owner,
        providerId: 'opencode',
        requiredLabels: ['fedora'],
        repositoryPath: '/home/owner/repos/OpenCortex',
      }).selected?.id,
    ).toBe(host.id);
    expect(
      controlPlane.selectHost({
        user: owner,
        providerId: 'claude',
        requiredLabels: ['fedora'],
        repositoryPath: '/home/owner/repos/OpenCortex',
      }).rejected,
    ).toEqual([{ hostId: host.id, reason: 'provider_not_ready' }]);
    controlPlane.heartbeatHost(owner, host.id, { capacity: { sessions: 0 } });
    expect(
      controlPlane.selectHost({
        user: owner,
        providerId: 'opencode',
        requiredLabels: ['fedora'],
        repositoryPath: '/home/owner/repos/OpenCortex',
      }).rejected,
    ).toEqual([{ hostId: host.id, reason: 'capacity_full' }]);
    expect(() =>
      controlPlane.createWorktree({
        user: owner,
        taskId: task.id,
        hostId: host.id,
        path: '/etc/opencortex',
      }),
    ).toThrow(/escapes allowed roots/);
  });

  it('applies classroom cohort visibility without leaking peer sessions', () => {
    const controlPlane = store();
    const teacher = user('teacher@acme.test');
    const student = user('student@acme.test');
    const peer = user('peer@acme.test');
    const cohort = controlPlane.createCohort({
      user: teacher,
      name: 'Agentic Software 101',
    });
    controlPlane.addEnrollment({
      user: teacher,
      cohortId: cohort.id,
      email: student.email,
      subject: student.sub,
      role: 'student',
    });

    expect(controlPlane.listCohorts(student).map(item => item.id)).toEqual([
      cohort.id,
    ]);
    expect(controlPlane.listCohorts(peer)).toEqual([]);
    expect(controlPlane.listEnrollments(student, cohort.id)).toEqual([
      expect.objectContaining({ subject: student.sub, role: 'student' }),
    ]);
  });
});
