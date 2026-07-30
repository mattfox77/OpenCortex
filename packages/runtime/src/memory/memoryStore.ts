import { createHash } from 'node:crypto';
import pg from 'pg';
import type { AppConfig } from '../config/config.js';

const { Pool } = pg;

export type MemoryEntryKind = 'thought' | 'finding' | 'decision' | 'document' | 'chunk';
export type MemoryEntryScope = 'personal' | 'team' | 'global';
export type MemoryEntryAuthor = 'user' | 'agent';

export interface MemoryEntry {
  id: string;
  createdAt: string;
  title?: string;
  content: string;
  kind: MemoryEntryKind;
  scope: MemoryEntryScope;
  project?: string;
  repo?: string;
  sourceSystem?: string;
  sourceSessionId?: string;
  toolName?: string;
  ownerId: string;
  author: MemoryEntryAuthor;
  review: 'approved' | 'pending' | 'archived';
  tags: string[];
  identitySubject?: string;
  score?: number;
}

export interface CaptureMemoryEntryInput {
  ownerId: string;
  identitySubject: string;
  content: string;
  title?: string;
  kind: MemoryEntryKind;
  scope: MemoryEntryScope;
  project?: string;
  repo?: string;
  sourceSystem?: string;
  sourceSessionId?: string;
  toolName?: string;
  author: MemoryEntryAuthor;
  tags: string[];
  meta: Record<string, unknown>;
}

export interface SearchMemoryEntriesInput {
  ownerId: string;
  identitySubject: string;
  query?: string;
  limit: number;
  project?: string;
  scope?: MemoryEntryScope;
  repo?: string;
  includePending: boolean;
}

export interface MemoryStore {
  captureEntry(input: CaptureMemoryEntryInput): Promise<MemoryEntry>;
  searchEntries(input: SearchMemoryEntriesInput): Promise<MemoryEntry[]>;
}

export function createMemoryStore(config: AppConfig): MemoryStore | undefined {
  if (!config.OPENCORTEX_MEMORY_DATABASE_URL) {
    return undefined;
  }
  return new PgMemoryStore(config.OPENCORTEX_MEMORY_DATABASE_URL);
}

export class PgMemoryStore implements MemoryStore {
  private readonly pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  async captureEntry(input: CaptureMemoryEntryInput): Promise<MemoryEntry> {
    const contentHash = createHash('sha256').update(input.content).digest('hex');
    const result = await this.pool.query<MemoryEntryRow>(
      `
        INSERT INTO entries (
          content, title, kind, scope, owner_id, author, content_hash, project,
          repo, source_system, source_session_id, tool_name, tags, meta,
          identity_subject
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, $14, $15
        )
        ON CONFLICT DO NOTHING
        RETURNING ${entryColumns}
      `,
      [
        input.content,
        input.title ?? null,
        input.kind,
        input.scope,
        input.ownerId,
        input.author,
        contentHash,
        input.project ?? null,
        input.repo ?? null,
        input.sourceSystem ?? null,
        input.sourceSessionId ?? null,
        input.toolName ?? null,
        input.tags,
        input.meta,
        input.identitySubject,
      ],
    );
    if (result.rows[0]) {
      await this.logCapture(input, result.rows[0].id);
      return entryFromRow(result.rows[0]);
    }

    const existing = await this.pool.query<MemoryEntryRow>(
      `SELECT ${entryColumns} FROM entries WHERE content_hash = $1 LIMIT 1`,
      [contentHash],
    );
    if (!existing.rows[0]) {
      throw new Error('memory entry insert did not return a row');
    }
    return entryFromRow(existing.rows[0]);
  }

  async searchEntries(input: SearchMemoryEntriesInput): Promise<MemoryEntry[]> {
    const values: unknown[] = [input.ownerId, input.identitySubject, input.limit];
    const predicates = [
      "e.review != 'archived'",
      [
        "(e.scope = 'global'",
        "OR e.scope = 'team'",
        "OR (e.scope = 'personal'",
        "AND (e.identity_subject = $2",
        "OR (e.identity_subject IS NULL AND e.owner_id = $1))))",
      ].join(' '),
    ];
    if (!input.includePending) {
      predicates.push("e.review = 'approved'");
    }
    if (input.project) {
      values.push(input.project);
      predicates.push(`e.project = $${values.length}`);
    }
    if (input.scope) {
      values.push(input.scope);
      predicates.push(`e.scope = $${values.length}`);
    }
    if (input.repo) {
      values.push(input.repo);
      predicates.push(`e.repo = $${values.length}`);
    }

    let score = 'NULL::real AS score';
    let order = 'e.created_at DESC';
    if (input.query) {
      values.push(input.query);
      const queryParam = `$${values.length}`;
      predicates.push(`e.fts @@ plainto_tsquery('english', ${queryParam})`);
      score = `ts_rank_cd(e.fts, plainto_tsquery('english', ${queryParam}))::real AS score`;
      order = 'score DESC, e.created_at DESC';
    }

    const result = await this.pool.query<MemoryEntryRow>(
      `
        SELECT ${entrySelectColumns('e')}, ${score}
        FROM entries e
        WHERE ${predicates.join(' AND ')}
        ORDER BY ${order}
        LIMIT $3
      `,
      values,
    );
    return result.rows.map(entryFromRow);
  }

  private async logCapture(
    input: CaptureMemoryEntryInput,
    entryId: string,
  ): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO log (
          kind, summary, project, owner_id, data, entry_id, identity_subject
        )
        VALUES ('capture', $1, $2, $3, $4, $5, $6)
      `,
      [
        `Captured: ${input.title ?? input.content.slice(0, 40)}`,
        input.project ?? null,
        input.ownerId,
        { sourceSystem: input.sourceSystem, sourceSessionId: input.sourceSessionId },
        entryId,
        input.identitySubject,
      ],
    );
  }
}

interface MemoryEntryRow {
  id: string;
  createdAt: Date | string;
  title: string | null;
  content: string;
  kind: MemoryEntryKind;
  scope: MemoryEntryScope;
  project: string | null;
  repo: string | null;
  sourceSystem: string | null;
  sourceSessionId: string | null;
  toolName: string | null;
  ownerId: string;
  author: MemoryEntryAuthor;
  review: 'approved' | 'pending' | 'archived';
  tags: string[] | null;
  identitySubject: string | null;
  score?: number | null;
}

const entryColumns = `
  id,
  created_at AS "createdAt",
  title,
  content,
  kind,
  scope,
  project,
  repo,
  source_system AS "sourceSystem",
  source_session_id AS "sourceSessionId",
  tool_name AS "toolName",
  owner_id AS "ownerId",
  author,
  review,
  tags,
  identity_subject AS "identitySubject"
`;

function entrySelectColumns(alias: string): string {
  return `
    ${alias}.id,
    ${alias}.created_at AS "createdAt",
    ${alias}.title,
    ${alias}.content,
    ${alias}.kind,
    ${alias}.scope,
    ${alias}.project,
    ${alias}.repo,
    ${alias}.source_system AS "sourceSystem",
    ${alias}.source_session_id AS "sourceSessionId",
    ${alias}.tool_name AS "toolName",
    ${alias}.owner_id AS "ownerId",
    ${alias}.author,
    ${alias}.review,
    ${alias}.tags,
    ${alias}.identity_subject AS "identitySubject"
  `;
}

function entryFromRow(row: MemoryEntryRow): MemoryEntry {
  return {
    id: row.id,
    createdAt:
      row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    ...(row.title ? { title: row.title } : {}),
    content: row.content,
    kind: row.kind,
    scope: row.scope,
    ...(row.project ? { project: row.project } : {}),
    ...(row.repo ? { repo: row.repo } : {}),
    ...(row.sourceSystem ? { sourceSystem: row.sourceSystem } : {}),
    ...(row.sourceSessionId ? { sourceSessionId: row.sourceSessionId } : {}),
    ...(row.toolName ? { toolName: row.toolName } : {}),
    ownerId: row.ownerId,
    author: row.author,
    review: row.review,
    tags: row.tags ?? [],
    ...(row.identitySubject ? { identitySubject: row.identitySubject } : {}),
    ...(row.score !== null && row.score !== undefined ? { score: row.score } : {}),
  };
}
