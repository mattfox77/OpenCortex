import { chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../src/code/sessionStore.js';
import type { CodeSession } from '../src/code/sessionLauncher.js';

const listeners: net.Server[] = [];

function listenOnEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Expected TCP address'));
        return;
      }
      listeners.push(srv);
      resolve(address.port);
    });
  });
}

function makeSession(overrides: Partial<CodeSession>): CodeSession {
  return {
    id: 'sess-1',
    createdAt: new Date().toISOString(),
    ownerEmail: 'tester@dsn.com',
    linuxUser: 'tester',
    workspaceDir: '/home/tester/repos',
    port: 4100,
    urlPath: '/diwan/code/session/sess-1/',
    command: ['opencode', 'web'],
    mode: 'sudo',
    ...overrides,
  };
}

afterEach(() => {
  for (const srv of listeners.splice(0)) {
    srv.close();
  }
});

describe('SessionStore', () => {
  it('persists sessions across instances backed by the same dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'diwan-store-'));
    const a = new SessionStore(dir);
    a.set('sess-1', makeSession({ id: 'sess-1' }));

    const b = new SessionStore(dir);
    // A fresh instance (simulating a process restart) reads the same file.
    expect([...b.values()].map(s => s.id)).toContain('sess-1');
  });

  it('keeps sessions whose port is still listening after init()', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'diwan-store-'));
    const livePort = await listenOnEphemeralPort();

    const a = new SessionStore(dir);
    a.set('live', makeSession({ id: 'live', port: livePort }));

    const restarted = new SessionStore(dir);
    await restarted.init();
    expect([...restarted.values()].map(s => s.id)).toEqual(['live']);
  });

  it('keeps sessions whose port is dead after init() so they can be relaunched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'diwan-store-'));
    // Grab a port then immediately release it, so nothing is listening.
    const deadPort = await listenOnEphemeralPort();
    listeners.splice(0).forEach(srv => srv.close());

    const a = new SessionStore(dir);
    a.set('dead', makeSession({ id: 'dead', port: deadPort }));

    const restarted = new SessionStore(dir);
    await restarted.init();
    expect([...restarted.values()].map(s => s.id)).toEqual(['dead']);
  });

  it('keeps aws-ssm sessions after init() even without a local listener', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'diwan-store-'));
    const deadPort = await listenOnEphemeralPort();
    listeners.splice(0).forEach(srv => srv.close());

    const a = new SessionStore(dir);
    a.set(
      'ssm',
      makeSession({
        id: 'ssm',
        port: deadPort,
        mode: 'aws-ssm',
        aws: {
          region: 'us-east-1',
          targetInstanceId: 'i-test',
          remotePort: deadPort,
          localPort: deadPort + 1000,
          commandId: 'cmd-test',
          startSessionCommand: ['aws', 'ssm', 'start-session'],
          localUrl: 'http://127.0.0.1:5100/',
        },
      }),
    );

    const restarted = new SessionStore(dir);
    await restarted.init();
    expect([...restarted.values()].map(s => s.id)).toEqual(['ssm']);
  });

  it('delete removes a session and persists the removal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'diwan-store-'));
    const a = new SessionStore(dir);
    a.set('sess-1', makeSession({ id: 'sess-1' }));
    expect(a.delete('sess-1')).toBe(true);

    const b = new SessionStore(dir);
    expect([...b.values()]).toHaveLength(0);
  });

  it('finds the latest persisted workspace for an owner', () => {
    const dir = mkdtempSync(join(tmpdir(), 'diwan-store-'));
    const store = new SessionStore(dir);
    store.set(
      'old',
      makeSession({
        id: 'old',
        ownerEmail: 'tester@dsn.com',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    store.set(
      'new',
      makeSession({
        id: 'new',
        ownerEmail: 'tester@dsn.com',
        createdAt: '2026-01-02T00:00:00.000Z',
      }),
    );
    store.set(
      'other',
      makeSession({ id: 'other', ownerEmail: 'other@dsn.com' }),
    );

    expect(store.findByOwnerEmail('tester@dsn.com')?.id).toBe('new');
  });

  it('reports persistent for a writable dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'diwan-store-'));
    expect(new SessionStore(dir).isPersistent).toBe(true);
  });

  it('degrades to in-memory (no throw) when the data dir is unwritable', () => {
    const parent = mkdtempSync(join(tmpdir(), 'diwan-store-ro-'));
    const dir = join(parent, 'data');
    // Read+execute but not write: mkdir of the child + write probe both fail.
    chmodSync(parent, 0o555);
    try {
      let store!: SessionStore;
      expect(() => {
        store = new SessionStore(dir);
      }).not.toThrow();
      expect(store.isPersistent).toBe(false);

      // In-memory operations still work despite no persistence.
      expect(() => store.set('s', makeSession({ id: 's' }))).not.toThrow();
      expect([...store.values()].map(x => x.id)).toEqual(['s']);
    } finally {
      chmodSync(parent, 0o755);
    }
  });
});
