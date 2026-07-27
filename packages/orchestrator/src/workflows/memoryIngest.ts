import { proxyActivities, workflowInfo } from '@temporalio/workflow';
import type * as activities from '../activities';
import type { TraceContext } from '../telemetry';

const ingest = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 5 },
});

export interface MemoryIngestInput {
  content: string;
  artifactName: string;
  ownerId: string;
  sourceSystem: string;
  sourceSessionId?: string;
  project?: string;
  repo?: string;
  scope?: 'personal' | 'team' | 'global';
  toolName?: string;
  mimeType?: string;
  sourcePath?: string;
  traceContext?: TraceContext;
}

export interface MemoryIngestResult {
  workflowId: string;
  runId: string;
  artifactId: string;
  entryIds: string[];
  logId: string;
  chunkCount: number;
  ownerId: string;
  project?: string;
  sourceSystem: string;
  sourceSessionId?: string;
  traceContext?: TraceContext;
}

export async function memoryIngestWorkflow(
  input: MemoryIngestInput,
): Promise<MemoryIngestResult> {
  const info = workflowInfo();
  const workflowId = info.workflowId;
  const runId = info.runId;

  const artifact = await ingest.storeOriginalArtifact({
    ...input,
    workflowId,
    runId,
    traceContext: input.traceContext,
  });
  const extracted = await ingest.extractArtifactText({
    content: input.content,
    artifactId: artifact.artifactId,
    mimeType: artifact.mimeType,
    workflowId,
    runId,
    traceContext: input.traceContext,
  });
  const chunks = await ingest.chunkArtifactText({
    text: extracted.text,
    artifactId: artifact.artifactId,
    workflowId,
    runId,
    traceContext: input.traceContext,
  });
  const entries = await ingest.writeMemoryChunks({
    artifact,
    chunks: chunks.chunks,
    ownerId: input.ownerId,
    project: input.project,
    repo: input.repo,
    scope: input.scope ?? 'personal',
    sourceSystem: input.sourceSystem,
    sourceSessionId: input.sourceSessionId,
    toolName: input.toolName,
    workflowId,
    runId,
    traceContext: input.traceContext,
  });
  await ingest.linkArtifactEntries({
    artifactId: artifact.artifactId,
    entryIds: entries.entryIds,
    ownerId: input.ownerId,
    workflowId,
    runId,
    traceContext: input.traceContext,
  });
  const audit = await ingest.writeIngestAuditEvent({
    artifactId: artifact.artifactId,
    entryIds: entries.entryIds,
    ownerId: input.ownerId,
    project: input.project,
    sourceSystem: input.sourceSystem,
    sourceSessionId: input.sourceSessionId,
    workflowId,
    runId,
    traceContext: input.traceContext,
  });
  await ingest.upsertWorkflowProjection({
    workflowId,
    runId,
    workflowType: 'MemoryIngestWorkflow',
    status: 'completed',
    ownerId: input.ownerId,
    project: input.project,
    sourceSystem: input.sourceSystem,
    sourceSessionId: input.sourceSessionId,
    artifactId: artifact.artifactId,
    entryIds: entries.entryIds,
    summary: `Ingested ${input.artifactName} into ${entries.entryIds.length} memory chunk(s)`,
    data: {
      artifactName: input.artifactName,
      storageUri: artifact.storageUri,
      logId: audit.logId,
      traceId: input.traceContext?.traceId,
    },
    traceContext: input.traceContext,
  });

  return {
    workflowId,
    runId,
    artifactId: artifact.artifactId,
    entryIds: entries.entryIds,
    logId: audit.logId,
    chunkCount: chunks.chunks.length,
    ownerId: input.ownerId,
    project: input.project,
    sourceSystem: input.sourceSystem,
    sourceSessionId: input.sourceSessionId,
    traceContext: input.traceContext,
  };
}
