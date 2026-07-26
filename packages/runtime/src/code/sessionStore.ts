import {
  accessSync,
  constants as fsConstants,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import type { CodeSession } from './sessionLauncher.js';

/**
 * Durable, process-restart-surviving store for code sessions.
 *
 * Sessions are held in memory (fast path for the request handlers) and
 * mirrored to a JSONL-style JSON file in DIWAN_DATA_DIR so that a restart of
 * the OpenCortex service does not lose the record of OpenCode processes. On startup,
 * `init()` reloads the persisted sessions without dropping records whose
 * backing OpenCode port is temporarily down; request handlers can use the saved
 * launch metadata to restart them.
 *
 * Implements the subset of the Map API the request handlers use (`get`,
 * `set`, `delete`, `values`) so it is a drop-in replacement for the previous
 * in-memory `Map<string, CodeSession>`.
 */
export class SessionStore {
  private readonly filePath: string;
  private readonly sessions = new Map<string, CodeSession>();
  private persistent = false;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'code-sessions.json');
    this.persistent = this.ensureWritable(dataDir);
    if (!this.persistent) {
      console.warn(
        `[diwan] code-session data dir is not writable: ${dataDir}. ` +
          'Sessions will work but will NOT survive a diwan restart. ' +
          'Set DIWAN_DATA_DIR to a path the service user can write ' +
          '(e.g. /var/lib/opencortex).',
      );
    }
    // Populate the in-memory map from disk immediately so reads work before
    // init() runs.
    for (const session of this.readFromDisk()) {
      this.sessions.set(session.id, session);
    }
  }

  /** True when sessions are being persisted to disk (survive a restart). */
  get isPersistent(): boolean {
    return this.persistent;
  }

  /**
   * Load persisted sessions. Returns an empty list for compatibility with the
   * startup archiving call site; dead sessions are kept so they can be
   * relaunched instead of being lost.
   */
  async init(): Promise<CodeSession[]> {
    const loaded = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of loaded) {
      this.sessions.set(session.id, session);
    }
    this.persist();
    return [];
  }

  get(id: string): CodeSession | undefined {
    return this.sessions.get(id);
  }

  findByOwnerEmail(ownerEmail: string): CodeSession | undefined {
    return [...this.sessions.values()]
      .filter(session => session.ownerEmail === ownerEmail)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }

  set(id: string, session: CodeSession): this {
    this.sessions.set(id, session);
    this.persist();
    return this;
  }

  delete(id: string): boolean {
    const existed = this.sessions.delete(id);
    if (existed) {
      this.persist();
    }
    return existed;
  }

  values(): IterableIterator<CodeSession> {
    return this.sessions.values();
  }

  private readFromDisk(): CodeSession[] {
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter(
        (item): item is CodeSession =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as CodeSession).id === 'string' &&
          typeof (item as CodeSession).port === 'number',
      );
    } catch {
      // Missing or corrupt file — start empty rather than crash the server.
      return [];
    }
  }

  /**
   * Create the data dir if needed and verify it is writable. Returns true if
   * the store can persist to disk; false (without throwing) if the directory
   * cannot be created or written, so an unwritable data dir degrades to
   * in-memory-only instead of crashing the server at startup.
   */
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
    const payload = JSON.stringify([...this.sessions.values()], null, 2);
    try {
      writeFileSync(this.filePath, `${payload}\n`, { encoding: 'utf8' });
    } catch (error) {
      // A write that fails after the dir passed the startup writability probe
      // (disk full, perms changed at runtime) disables further persistence and
      // warns once, rather than throwing on every mutation.
      this.persistent = false;
      console.warn(
        `[diwan] failed to persist code sessions to ${this.filePath}; ` +
          'disabling persistence for this process. ' +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export async function isSessionRestorable(
  session: CodeSession,
): Promise<boolean> {
  return isPortListening(session.port);
}

/**
 * Returns true if something is accepting TCP connections on 127.0.0.1:<port>
 * within a short timeout. Used to decide whether a persisted session's
 * OpenCode process survived a diwan restart.
 */
export function isPortListening(
  port: number,
  timeoutMs = 500,
): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}
