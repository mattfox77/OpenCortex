#!/usr/bin/env ts-node
/**
 * Execute MemoryIngestWorkflow against mocked activities, verify a transient
 * activity failure retries to completion, then replay the resulting Temporal
 * histories to catch workflow non-determinism in CI.
 */
import assert from 'assert';
import { randomUUID } from 'crypto';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { memoryIngestWorkflow, MemoryIngestResult } from '../src/workflows/memoryIngest';
import type * as activities from '../src/activities';

const taskQueue = `memory-ingest-replay-${process.pid}`;
const retryWorkflowMarker = '-retry-';
const writeAttempts = new Map<string, number>();

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
  async writeMemoryChunks(params) {
    const attempt = (writeAttempts.get(params.workflowId) ?? 0) + 1;
    writeAttempts.set(params.workflowId, attempt);
    if (params.workflowId.includes(retryWorkflowMarker) && attempt === 1) {
      throw new Error('transient replay fixture failure');
    }
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
    const retryWorkflowId = `memory-ingest${retryWorkflowMarker}${randomUUID()}`;
    const results = await worker.runUntil(async () => {
      const handle = await startFixtureWorkflow(env, workflowId);
      const retryHandle = await startFixtureWorkflow(env, retryWorkflowId);
      const result = await handle.result() as MemoryIngestResult;
      const retryResult = await retryHandle.result() as MemoryIngestResult;
      return {
        result,
        retryResult,
        history: await handle.fetchHistory(),
        retryHistory: await retryHandle.fetchHistory(),
      };
    });

    const { result, retryResult, history, retryHistory } = results;
    assert.equal(result.artifactId, 'artifact-replay-1');
    assert.deepEqual(result.entryIds, ['entry-replay-1']);
    assert.equal(result.logId, 'log-replay-1');
    assert.equal(result.traceContext?.traceId, '1'.repeat(32));
    assert.equal(retryResult.artifactId, 'artifact-replay-1');
    assert.deepEqual(retryResult.entryIds, ['entry-replay-1']);
    assert.equal(writeAttempts.get(retryWorkflowId), 2);

    await Worker.runReplayHistory(
      { workflowsPath: require.resolve('../src/workflows') },
      history,
      workflowId,
    );
    await Worker.runReplayHistory(
      { workflowsPath: require.resolve('../src/workflows') },
      retryHistory,
      retryWorkflowId,
    );

    console.log(`Replay passed for ${workflowId}`);
    console.log(`Retry and replay passed for ${retryWorkflowId}`);
  } finally {
    await env.teardown();
  }
}

async function startFixtureWorkflow(
  env: TestWorkflowEnvironment,
  workflowId: string,
) {
  return env.client.workflow.start(memoryIngestWorkflow, {
    workflowId,
    taskQueue,
    args: [{
      content: '# Replay fixture\n\nTemporal replay must stay deterministic.',
      artifactName: 'replay.md',
      ownerId: 'owner-replay',
      sourceSystem: 'test',
      sourceSessionId: 'session-replay',
      project: 'opencortex',
      identitySubject: 'oidc:test:user-123',
      traceContext: {
        traceId: '1'.repeat(32),
        parentSpanId: '2'.repeat(16),
      },
    }],
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
