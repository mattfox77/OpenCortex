#!/usr/bin/env ts-node
/**
 * Rebuild workflow_projection from Temporal Visibility.
 *
 * Temporal remains source of truth. This command replays completed
 * MemoryIngestWorkflow results into the memory read model.
 */

import { Connection, Client } from '@temporalio/client';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import type { MemoryIngestResult } from '../src/workflows/memoryIngest';

dotenv.config();

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
  const memory = createClient(
    requiredEnv('SUPABASE_URL'),
    requiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
  );

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
    const { error } = await memory
      .from('workflow_projection')
      .upsert(row, { onConflict: 'workflow_id' });
    if (error) {
      throw new Error(`Projection rebuild failed for ${execution.workflowId}: ${error.message}`);
    }
    rebuilt++;
  }

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
      rebuiltFromTemporalVisibility: true,
    },
    completed_at: new Date().toISOString(),
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
