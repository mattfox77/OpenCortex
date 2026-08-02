#!/usr/bin/env ts-node
/**
 * Rebuild workflow_projection from Temporal Visibility.
 *
 * Temporal remains source of truth. This command replays completed
 * MemoryIngestWorkflow results into the memory read model.
 */

import { Connection, Client } from '@temporalio/client';
import * as dotenv from 'dotenv';
import pg from 'pg';
import type { MemoryIngestResult } from '../src/workflows/memoryIngest';

dotenv.config();
const { Pool } = pg;

async function main() {
  const args = process.argv.slice(2);
  let query = 'WorkflowType="memoryIngestWorkflow" AND ExecutionStatus="Completed"';
  let limit = 500;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--query':
        query = args[++i] ?? query;
        break;
      case '--limit':
        limit = Number(args[++i] ?? limit);
        break;
      case '--dry-run':
        dryRun = true;
        break;
      default:
        throw new Error(`Unknown argument: ${args[i]}`);
    }
  }

  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS || 'localhost:7233',
  });
  const temporal = new Client({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE || 'default',
  });
  const memory = new Pool({ connectionString: requiredMemoryDatabaseUrl() });

  let scanned = 0;
  let rebuilt = 0;
  for await (const execution of temporal.workflow.list({ query })) {
    if (scanned >= limit) {
      break;
    }
    scanned++;
    const handle = temporal.workflow.getHandle(execution.workflowId, execution.runId);
    const result = await handle.result() as MemoryIngestResult;
    const row = projectionRowFromResult(result);
    if (dryRun) {
      console.log(JSON.stringify(row));
      rebuilt++;
      continue;
    }
    await upsertProjection(memory, row);
    rebuilt++;
  }
  await memory.end();

  console.log(`Rebuilt ${rebuilt} workflow_projection row(s) from ${scanned} Temporal execution(s).`);
}

function projectionRowFromResult(result: MemoryIngestResult): Record<string, unknown> {
  return {
    workflow_id: result.workflowId,
    run_id: result.runId,
    workflow_type: 'MemoryIngestWorkflow',
    status: 'completed',
    owner_id: result.ownerId,
    project: result.project ?? null,
    source_system: result.sourceSystem,
    source_session_id: result.sourceSessionId ?? null,
    artifact_id: result.artifactId,
    entry_ids: result.entryIds,
    summary: `Ingested artifact ${result.artifactId} into ${result.entryIds.length} memory chunk(s)`,
    data: {
      logId: result.logId,
      chunkCount: result.chunkCount,
      traceId: result.traceContext?.traceId,
      rebuiltFromTemporalVisibility: true,
    },
    completed_at: new Date().toISOString(),
  };
}

async function upsertProjection(
  memory: pg.Pool,
  row: Record<string, unknown>,
): Promise<void> {
  await memory.query(
    `
      INSERT INTO workflow_projection (
        workflow_id, run_id, workflow_type, status, owner_id, project,
        source_system, source_session_id, artifact_id, entry_ids, summary,
        data, completed_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11,
        $12, $13
      )
      ON CONFLICT (workflow_id) DO UPDATE
      SET run_id = EXCLUDED.run_id,
          workflow_type = EXCLUDED.workflow_type,
          status = EXCLUDED.status,
          owner_id = EXCLUDED.owner_id,
          project = EXCLUDED.project,
          source_system = EXCLUDED.source_system,
          source_session_id = EXCLUDED.source_session_id,
          artifact_id = EXCLUDED.artifact_id,
          entry_ids = EXCLUDED.entry_ids,
          summary = EXCLUDED.summary,
          data = EXCLUDED.data,
          completed_at = EXCLUDED.completed_at,
          updated_at = now()
    `,
    [
      row.workflow_id,
      row.run_id,
      row.workflow_type,
      row.status,
      row.owner_id,
      row.project,
      row.source_system,
      row.source_session_id,
      row.artifact_id,
      row.entry_ids,
      row.summary,
      row.data,
      row.completed_at,
    ],
  );
}

function requiredMemoryDatabaseUrl(): string {
  const value =
    process.env.OPENCORTEX_MEMORY_DATABASE_URL ??
    process.env.DIWAN_MEMORY_DATABASE_URL ??
    process.env.MEMORY_DATABASE_URL;
  if (!value) {
    throw new Error('Set OPENCORTEX_MEMORY_DATABASE_URL to rebuild workflow projections');
  }
  return value;
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
