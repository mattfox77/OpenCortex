import { proxyActivities, workflowInfo } from '@temporalio/workflow';
import type * as activities from '../activities';
import type { TraceContext } from '../telemetry';

const sync = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 5 },
});

export interface ArtifactSyncInput {
  rootDir: string;
  ownerId: string;
  sourceSystem?: string;
  sourceSessionId?: string;
  project?: string;
  repo?: string;
  scope?: 'personal' | 'team' | 'global';
  toolName?: string;
  identitySubject?: string;
  includeExtensions?: string[];
  excludeDirs?: string[];
  maxFiles?: number;
  maxBytes?: number;
  traceContext?: TraceContext;
}

export interface ArtifactSyncItemResult {
  sourcePath: string;
  artifactId: string;
  entryIds: string[];
  logId: string;
  chunkCount: number;
  sha256: string;
}

export interface ArtifactSyncResult {
  workflowId: string;
  runId: string;
  ownerId: string;
  rootDir: string;
  sourceSystem: string;
  sourceSessionId?: string;
  project?: string;
  syncedCount: number;
  skippedCount: number;
  artifactIds: string[];
  entryIds: string[];
  items: ArtifactSyncItemResult[];
  traceContext?: TraceContext;
}

export async function artifactSyncWorkflow(
  input: ArtifactSyncInput,
): Promise<ArtifactSyncResult> {
  const info = workflowInfo();
  const workflowId = info.workflowId;
  const runId = info.runId;
  const sourceSystem = input.sourceSystem ?? 'opencortex-artifact-sync';
  const sourceSessionId = input.sourceSessionId ?? input.rootDir;

  await sync.upsertWorkflowProjection({
    workflowId,
    runId,
    workflowType: 'ArtifactSyncWorkflow',
    status: 'running',
    ownerId: input.ownerId,
    project: input.project,
    sourceSystem,
    sourceSessionId,
    summary: `Scanning artifacts under ${input.rootDir}`,
    data: {
      rootDir: input.rootDir,
      traceId: input.traceContext?.traceId,
    },
    traceContext: input.traceContext,
  });

  await sync.upsertArtifactSyncState({
    sourceSystem,
    ownerId: input.ownerId,
    project: input.project,
    repo: input.repo,
    status: 'running',
    stats: {
      rootDir: input.rootDir,
    },
    traceContext: input.traceContext,
  });

  try {
    const scanned = await sync.scanArtifactFiles({
      rootDir: input.rootDir,
      sourceSystem,
      includeExtensions: input.includeExtensions,
      excludeDirs: input.excludeDirs,
      maxFiles: input.maxFiles,
      maxBytes: input.maxBytes,
      traceContext: input.traceContext,
    });

    const items: ArtifactSyncItemResult[] = [];
    const artifactIds: string[] = [];
    const entryIds: string[] = [];

    for (const file of scanned.files) {
      const artifact = await sync.storeOriginalArtifact({
        content: file.content,
        artifactName: file.artifactName,
        ownerId: input.ownerId,
        sourceSystem,
        sourceSessionId,
        project: input.project,
        repo: input.repo,
        scope: input.scope ?? 'personal',
        toolName: input.toolName ?? 'artifact-sync',
        mimeType: file.mimeType,
        sourcePath: file.sourcePath,
        identitySubject: input.identitySubject,
        workflowId,
        runId,
        traceContext: input.traceContext,
      });
      const extracted = await sync.extractArtifactText({
        content: file.content,
        artifactId: artifact.artifactId,
        mimeType: artifact.mimeType,
        workflowId,
        runId,
        traceContext: input.traceContext,
      });
      const chunks = await sync.chunkArtifactText({
        text: extracted.text,
        artifactId: artifact.artifactId,
        workflowId,
        runId,
        traceContext: input.traceContext,
      });
      const entries = await sync.writeMemoryChunks({
        artifact,
        chunks: chunks.chunks,
        ownerId: input.ownerId,
        project: input.project,
        repo: input.repo,
        scope: input.scope ?? 'personal',
        sourceSystem,
        sourceSessionId,
        toolName: input.toolName ?? 'artifact-sync',
        identitySubject: input.identitySubject,
        workflowId,
        runId,
        traceContext: input.traceContext,
      });
      await sync.linkArtifactEntries({
        artifactId: artifact.artifactId,
        entryIds: entries.entryIds,
        ownerId: input.ownerId,
        workflowId,
        runId,
        traceContext: input.traceContext,
      });
      const audit = await sync.writeIngestAuditEvent({
        artifactId: artifact.artifactId,
        entryIds: entries.entryIds,
        ownerId: input.ownerId,
        project: input.project,
        sourceSystem,
        sourceSessionId,
        identitySubject: input.identitySubject,
        workflowId,
        runId,
        traceContext: input.traceContext,
      });

      artifactIds.push(artifact.artifactId);
      entryIds.push(...entries.entryIds);
      items.push({
        sourcePath: file.sourcePath,
        artifactId: artifact.artifactId,
        entryIds: entries.entryIds,
        logId: audit.logId,
        chunkCount: chunks.chunks.length,
        sha256: artifact.sha256,
      });
    }

    const result: ArtifactSyncResult = {
      workflowId,
      runId,
      ownerId: input.ownerId,
      rootDir: scanned.rootDir,
      sourceSystem,
      sourceSessionId,
      project: input.project,
      syncedCount: items.length,
      skippedCount: 0,
      artifactIds,
      entryIds,
      items,
      traceContext: input.traceContext,
    };

    await sync.upsertArtifactSyncState({
      sourceSystem,
      ownerId: input.ownerId,
      project: input.project,
      repo: input.repo,
      status: 'ok',
      lastCursor: items.at(-1)?.sourcePath,
      stats: {
        rootDir: scanned.rootDir,
        scannedCount: scanned.files.length,
        syncedCount: items.length,
        entryCount: entryIds.length,
      },
      traceContext: input.traceContext,
    });

    await sync.upsertWorkflowProjection({
      workflowId,
      runId,
      workflowType: 'ArtifactSyncWorkflow',
      status: 'completed',
      ownerId: input.ownerId,
      project: input.project,
      sourceSystem,
      sourceSessionId,
      artifactId: artifactIds[0],
      entryIds,
      summary: `Synced ${items.length} artifact(s) from ${input.rootDir}`,
      data: {
        result,
        traceId: input.traceContext?.traceId,
      },
      traceContext: input.traceContext,
    });

    return result;
  } catch (error) {
    await sync.upsertArtifactSyncState({
      sourceSystem,
      ownerId: input.ownerId,
      project: input.project,
      repo: input.repo,
      status: 'failed',
      stats: {
        rootDir: input.rootDir,
      },
      error: errorMessage(error),
      traceContext: input.traceContext,
    });
    await sync.upsertWorkflowProjection({
      workflowId,
      runId,
      workflowType: 'ArtifactSyncWorkflow',
      status: 'failed',
      ownerId: input.ownerId,
      project: input.project,
      sourceSystem,
      sourceSessionId,
      summary: `Artifact sync failed: ${errorMessage(error)}`,
      data: {
        rootDir: input.rootDir,
        traceId: input.traceContext?.traceId,
      },
      traceContext: input.traceContext,
    });
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
