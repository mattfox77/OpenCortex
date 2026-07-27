#!/usr/bin/env ts-node
/**
 * Execute MemoryIngestWorkflow against mocked activities, then replay the
 * resulting Temporal history to catch workflow non-determinism in CI.
 */
import assert from 'assert';
import { randomUUID } from 'crypto';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { memoryIngestWorkflow, MemoryIngestResult } from '../src/workflows/memoryIngest';
import type * as activities from '../src/activities';

const taskQueue = `memory-ingest-replay-${process.pid}`;

const mockActivities: Pick<
  typeof activities,
  | 'storeOriginalArtifact'
  | 'extractArtifactText'
  | 'chunkArtifactText'
  | 'writeMemoryChunks'
  | 'linkArtifactEntries'
  | 'writeIngestAuditEvent'
  | 'upsertWorkflowProjection'
> = {
  async storeOriginalArtifact(params) {
    return {
      artifactId: 'artifact-replay-1',
      sha256: '0'.repeat(64),
      sizeBytes: Buffer.byteLength(params.content, 'utf8'),
      mimeType: params.mimeType ?? 'text/plain',
      storageUri: 'file:///tmp/opencortex/replay/artifact.txt',
      storageKey: 'replay/artifact.txt',
      sourcePath: params.sourcePath ?? params.artifactName,
    };
  },
  async extractArtifactText(params) {
    return {
      artifactId: params.artifactId,
      text: params.content.trim(),
    };
  },
  async chunkArtifactText(params) {
    return {
      artifactId: params.artifactId,
      chunks: [
        {
          index: 0,
          content: params.text,
          heading: 'Replay fixture',
        },
      ],
    };
  },
  async writeMemoryChunks() {
    return { entryIds: ['entry-replay-1'] };
  },
  async linkArtifactEntries() {
    return undefined;
  },
  async writeIngestAuditEvent() {
    return { logId: 'log-replay-1' };
  },
  async upsertWorkflowProjection() {
    return undefined;
  },
};

async function main(): Promise<void> {
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  try {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      workflowsPath: require.resolve('../src/workflows'),
      activities: mockActivities,
      taskQueue,
    });

    const workflowId = `memory-ingest-replay-${randomUUID()}`;
    let handle: ReturnType<typeof env.client.workflow.getHandle> | undefined;
    const result = await worker.runUntil(async () => {
      handle = await env.client.workflow.start(memoryIngestWorkflow, {
        workflowId,
        taskQueue,
        args: [{
          content: '# Replay fixture\n\nTemporal replay must stay deterministic.',
          artifactName: 'replay.md',
          ownerId: 'owner-replay',
          sourceSystem: 'test',
          sourceSessionId: 'session-replay',
          project: 'opencortex',
          traceContext: {
            traceId: '1'.repeat(32),
            parentSpanId: '2'.repeat(16),
          },
        }],
      });
      return handle.result() as Promise<MemoryIngestResult>;
    });

    assert.equal(result.artifactId, 'artifact-replay-1');
    assert.deepEqual(result.entryIds, ['entry-replay-1']);
    assert.equal(result.logId, 'log-replay-1');
    assert.equal(result.traceContext?.traceId, '1'.repeat(32));

    if (!handle) {
      throw new Error('Workflow handle was not created');
    }
    const history = await handle.fetchHistory();
    await Worker.runReplayHistory(
      { workflowsPath: require.resolve('../src/workflows') },
      history,
      workflowId,
    );

    console.log(`Replay passed for ${workflowId}`);
  } finally {
    await env.teardown();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
