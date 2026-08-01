import pg from 'pg';
import type { AppConfig } from '../config/config.js';

const { Pool } = pg;

export type WorkflowProjectionStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface WorkflowProjection {
  workflowId: string;
  runId: string;
  workflowType: string;
  status: WorkflowProjectionStatus;
  ownerId: string;
  project?: string;
  sourceSystem?: string;
  sourceSessionId?: string;
  artifactId?: string;
  entryIds: string[];
  summary: string;
  data: Record<string, unknown>;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}

export interface ListWorkflowProjectionsInput {
  ownerId: string;
  isSuperAdmin: boolean;
  workflowType?: string;
  status?: WorkflowProjectionStatus;
  project?: string;
  sourceSystem?: string;
  sourceSessionId?: string;
  limit: number;
}

export interface WorkflowProjectionStore {
  list(input: ListWorkflowProjectionsInput): Promise<WorkflowProjection[]>;
  get(
    workflowId: string,
    input: { ownerId: string; isSuperAdmin: boolean },
  ): Promise<WorkflowProjection | undefined>;
}

export function createWorkflowProjectionStore(
  config: AppConfig,
): WorkflowProjectionStore | undefined {
  if (!config.OPENCORTEX_MEMORY_DATABASE_URL) {
    return undefined;
  }
  return new PgWorkflowProjectionStore(config.OPENCORTEX_MEMORY_DATABASE_URL);
}

export class PgWorkflowProjectionStore implements WorkflowProjectionStore {
  private readonly pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  async list(input: ListWorkflowProjectionsInput): Promise<WorkflowProjection[]> {
    const values: unknown[] = [];
    const predicates: string[] = [];
    if (!input.isSuperAdmin) {
      values.push(input.ownerId);
      predicates.push(`owner_id = $${values.length}`);
    }
    if (input.workflowType) {
      values.push(input.workflowType);
      predicates.push(`workflow_type = $${values.length}`);
    }
    if (input.status) {
      values.push(input.status);
      predicates.push(`status = $${values.length}`);
    }
    if (input.project) {
      values.push(input.project);
      predicates.push(`project = $${values.length}`);
    }
    if (input.sourceSystem) {
      values.push(input.sourceSystem);
      predicates.push(`source_system = $${values.length}`);
    }
    if (input.sourceSessionId) {
      values.push(input.sourceSessionId);
      predicates.push(`source_session_id = $${values.length}`);
    }
    values.push(input.limit);

    const where = predicates.length ? `WHERE ${predicates.join(' AND ')}` : '';
    const result = await this.pool.query<WorkflowProjectionRow>(
      `
        SELECT ${workflowProjectionColumns}
        FROM workflow_projection
        ${where}
        ORDER BY COALESCE(completed_at, updated_at, started_at) DESC
        LIMIT $${values.length}
      `,
      values,
    );
    return result.rows.map(workflowProjectionFromRow);
  }

  async get(
    workflowId: string,
    input: { ownerId: string; isSuperAdmin: boolean },
  ): Promise<WorkflowProjection | undefined> {
    const values: unknown[] = [workflowId];
    const predicates = ['workflow_id = $1'];
    if (!input.isSuperAdmin) {
      values.push(input.ownerId);
      predicates.push(`owner_id = $${values.length}`);
    }
    const result = await this.pool.query<WorkflowProjectionRow>(
      `
        SELECT ${workflowProjectionColumns}
        FROM workflow_projection
        WHERE ${predicates.join(' AND ')}
        LIMIT 1
      `,
      values,
    );
    return result.rows[0] ? workflowProjectionFromRow(result.rows[0]) : undefined;
  }
}

interface WorkflowProjectionRow {
  workflowId: string;
  runId: string;
  workflowType: string;
  status: WorkflowProjectionStatus;
  ownerId: string;
  project: string | null;
  sourceSystem: string | null;
  sourceSessionId: string | null;
  artifactId: string | null;
  entryIds: string[] | null;
  summary: string;
  data: Record<string, unknown> | null;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
  updatedAt: Date | string;
}

const workflowProjectionColumns = `
  workflow_id AS "workflowId",
  run_id AS "runId",
  workflow_type AS "workflowType",
  status,
  owner_id AS "ownerId",
  project,
  source_system AS "sourceSystem",
  source_session_id AS "sourceSessionId",
  artifact_id AS "artifactId",
  entry_ids AS "entryIds",
  summary,
  data,
  started_at AS "startedAt",
  completed_at AS "completedAt",
  updated_at AS "updatedAt"
`;

function workflowProjectionFromRow(row: WorkflowProjectionRow): WorkflowProjection {
  return {
    workflowId: row.workflowId,
    runId: row.runId,
    workflowType: row.workflowType,
    status: row.status,
    ownerId: row.ownerId,
    ...(row.project ? { project: row.project } : {}),
    ...(row.sourceSystem ? { sourceSystem: row.sourceSystem } : {}),
    ...(row.sourceSessionId ? { sourceSessionId: row.sourceSessionId } : {}),
    ...(row.artifactId ? { artifactId: row.artifactId } : {}),
    entryIds: row.entryIds ?? [],
    summary: row.summary,
    data: row.data ?? {},
    ...(row.startedAt ? { startedAt: iso(row.startedAt) } : {}),
    ...(row.completedAt ? { completedAt: iso(row.completedAt) } : {}),
    updatedAt: iso(row.updatedAt),
  };
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
