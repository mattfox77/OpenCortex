import { Context } from '@temporalio/activity';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import pg from 'pg';
import { dirname, join, relative } from 'path';
import { TraceContext, withTraceSpan } from '../telemetry';

const { Pool } = pg;

// --- Shared memory database client ---
let _memoryPool: pg.Pool;
function memoryPool(): pg.Pool {
  if (!_memoryPool) {
    const connectionString =
      process.env.OPENCORTEX_MEMORY_DATABASE_URL ??
      process.env.DIWAN_MEMORY_DATABASE_URL ??
      process.env.MEMORY_DATABASE_URL;
    if (!connectionString) {
      throw new Error('Set OPENCORTEX_MEMORY_DATABASE_URL for orchestrator memory access');
    }
    _memoryPool = new Pool({ connectionString });
  }
  return _memoryPool;
}

const EMBEDDINGS_URL =
  process.env.OPENCORTEX_EMBEDDINGS_URL ??
  process.env.EMBED_URL ??
  'http://opencortex-embeddings:7997/v1/embeddings';
const EMBEDDINGS_MODEL =
  process.env.OPENCORTEX_EMBEDDINGS_MODEL ??
  process.env.EMBED_MODEL ??
  'nomic-ai/nomic-embed-text-v1.5';
const EMBEDDINGS_DIMENSIONS = Number(
  process.env.OPENCORTEX_EMBEDDINGS_DIMENSIONS ??
  process.env.EMBED_DIMENSIONS ??
  '768'
);
const EMBEDDINGS_KEY =
  process.env.OPENCORTEX_EMBEDDINGS_KEY ??
  process.env.EMBED_KEY;
const OBJECTS_LOCAL_DIR =
  process.env.OPENCORTEX_OBJECTS_LOCAL_DIR ??
  process.env.OBJECT_STORE_LOCAL_DIR ??
  '/var/lib/opencortex/objects';
const OBJECTS_BUCKET =
  process.env.OPENCORTEX_OBJECTS_BUCKET ??
  process.env.OBJECT_STORE_BUCKET ??
  'opencortex-artifacts';
const OBJECTS_PREFIX =
  process.env.OPENCORTEX_OBJECTS_PREFIX ??
  process.env.OBJECT_STORE_PREFIX ??
  'artifacts';

type EmbeddingResponse = {
  data: Array<{ embedding: number[] }>;
};

export interface StoredArtifact {
  artifactId: string;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  storageKey: string;
  storageUri: string;
  sourcePath: string;
}

export interface TextChunk {
  index: number;
  content: string;
  heading?: string;
}

export interface ProvisioningIdentityResult {
  email: string;
  linuxUser: string;
  requiredGroups: string[];
  groups: string[];
}

export interface UserProvisioningRunResult {
  linuxUser: string;
  script: string;
  output: string;
}

export interface ProvisionedSkillTarget {
  path: string;
  exists: boolean;
  installedPackCount: number;
}

export interface UserProvisioningVerificationResult {
  linuxUser: string;
  homeDir: string;
  workspaceDir: string;
  requiredPaths: string[];
  skillTargets: ProvisionedSkillTarget[];
  tools: Record<string, boolean>;
}

export interface RuntimeWorkbenchSession {
  id: string;
  ownerEmail?: string;
  linuxUser?: string;
  workspaceDir?: string;
  port?: number;
  urlPath?: string;
  openCodeSessionId?: string;
}

export interface RuntimeWorkbenchSessionResult {
  session: RuntimeWorkbenchSession;
  channel?: Record<string, unknown>;
}

export interface RuntimeWorkbenchProbeResult {
  sessionId: string;
  running: boolean;
  session?: RuntimeWorkbenchSession;
}

export type MemoryEntryReview =
  | 'approved'
  | 'pending'
  | 'archived'
  | 'rejected'
  | 'noise'
  | 'changes_requested';

export interface ReviewMemoryEntryResult {
  entryId: string;
  ownerId: string;
  project?: string;
  review: MemoryEntryReview;
}

export interface RuntimePairPromptDraft {
  id: string;
  sessionId: string;
  channelId: string;
  status: string;
  reviewSnapshotText?: string;
  reviewedByEmail?: string;
  openCodeMessageId?: string;
  failureCode?: string;
  failureMessage?: string;
}

export interface RuntimePairPromptResult {
  draft: RuntimePairPromptDraft;
}

export interface ArtifactSyncFile {
  artifactName: string;
  sourcePath: string;
  content: string;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  modifiedAt: string;
}

// ================================================================
// ACTIVITY: Execute a CLI command via OpenCode
// ================================================================
export async function executeCliCommand(params: {
  prompt: string;
  cwd?: string;
}): Promise<string> {
  const ctx = Context.current();

  // Heartbeat so Temporal knows we're alive during long CLI runs
  const hb = setInterval(() => ctx.heartbeat('running CLI...'), 10_000);

  try {
    const result = execFileSync('opencode', ['run', '-q', params.prompt], {
      cwd: params.cwd || process.cwd(),
      timeout: 600_000, // 10 min
      maxBuffer: 10 * 1024 * 1024, // 10 MB
      encoding: 'utf-8',
      env: { ...process.env },
    });
    return result.trim();
  } catch (err: any) {
    // If OpenCode isn't installed, fall back to a helpful error
    if (err.message?.includes('not found') || err.message?.includes('ENOENT')) {
      throw new Error(
        'OpenCode CLI not found. Install the pinned OpenCode runtime before starting the orchestrator worker.'
      );
    }
    // Return stderr as output if the command itself failed
    return err.stderr?.toString() || err.message || 'CLI command failed';
  } finally {
    clearInterval(hb);
  }
}

// ================================================================
// ACTIVITY: Search Cortex Memory
// ================================================================
export async function searchBrain(query: string): Promise<string> {
  const embedding = await getEmbedding(query);
  const ownerId = process.env.OPENCORTEX_OWNER_ID ?? process.env.OWNER_ID ?? 'system';

  const result = await memoryPool().query<{
    title: string | null;
    content: string;
    kind: string | null;
    score: number | string | null;
  }>(
    'SELECT * FROM search($1, $2::vector, $3, $4, NULL, NULL, $5, $6, NULL)',
    [query, vectorLiteral(embedding), ownerId, 5, 0.5, true],
  );

  if (!result.rows.length) return 'No relevant memory context found.';

  return result.rows
    .map((t, i) =>
      `[${i + 1}] (${Math.round(Number(t.score ?? 0) * 100)}% match, ` +
      `${t.kind ?? 'entry'}) ${t.title ?? '(untitled)'}\n${t.content}`
    )
    .join('\n\n');
}

// ================================================================
// ACTIVITY: Capture thought to Cortex Memory
// ================================================================
export async function captureToBrain(content: string): Promise<void> {
  const [embedding, metadata] = await Promise.all([
    getEmbedding(content),
    extractMetadata(content),
  ]);
  const ownerId = process.env.OPENCORTEX_OWNER_ID ?? process.env.OWNER_ID ?? 'system';
  const contentHash = sha256Hex(content);

  let existing: pg.QueryResult<{ id: string }>;
  try {
    existing = await memoryPool().query(
      'SELECT id FROM entries WHERE content_hash = $1 AND owner_id = $2 LIMIT 1',
      [contentHash, ownerId],
    );
  } catch (error) {
    console.error('Failed to lookup memory capture:', errorMessage(error));
    return;
  }
  if (existing.rows[0]?.id) {
    return;
  }

  try {
    await memoryPool().query(
      `
        INSERT INTO entries (
          content, title, embedding, kind, scope, owner_id, author,
          content_hash, source_system, meta
        )
        VALUES ($1, $2, $3::vector, 'thought', 'team', $4, 'agent', $5, 'opencortex', $6)
        ON CONFLICT DO NOTHING
      `,
      [content, firstLineTitle(content), vectorLiteral(embedding), ownerId, contentHash, {
        ...metadata,
        source: 'opencortex',
      }],
    );
  } catch (error) {
    console.error('Failed to capture to memory:', errorMessage(error));
  }
}

// ================================================================
// ACTIVITY: Update task ledger
// ================================================================
export async function updateLedger(params: {
  workflowId: string;
  status: string;
  taskType?: string;
  input?: any;
  output?: any;
}): Promise<void> {
  await memoryPool().query(
    `
      INSERT INTO task_ledger (
        temporal_workflow_id, task_type, status, input, output, started_at, completed_at
      )
      VALUES ($1, $2, $3, $4, $5, now(), $6)
      ON CONFLICT (temporal_workflow_id) DO UPDATE
      SET status = EXCLUDED.status,
          output = EXCLUDED.output,
          completed_at = COALESCE(EXCLUDED.completed_at, task_ledger.completed_at),
          updated_at = now()
    `,
    [
      params.workflowId,
      params.taskType || 'custom',
      params.status,
      params.input || {},
      params.output || {},
      ['completed', 'failed', 'cancelled'].includes(params.status) ? new Date().toISOString() : null,
    ],
  );
}

// ================================================================
// ACTIVITY: Get/Set shared workflow context
// ================================================================
export async function getWorkflowContext(
  workflowId: string,
  key: string
): Promise<any> {
  const result = await memoryPool().query<{ context_value: unknown }>(
    'SELECT context_value FROM workflow_context WHERE workflow_id = $1 AND context_key = $2 LIMIT 1',
    [workflowId, key],
  );
  return result.rows[0]?.context_value;
}

export async function setWorkflowContext(
  workflowId: string,
  key: string,
  value: any
): Promise<void> {
  await memoryPool().query(
    `
      INSERT INTO workflow_context (workflow_id, context_key, context_value, updated_by, updated_at)
      VALUES ($1, $2, $3, $4, now())
      ON CONFLICT (workflow_id, context_key) DO UPDATE
      SET context_value = EXCLUDED.context_value,
          updated_by = EXCLUDED.updated_by,
          updated_at = now()
    `,
    [workflowId, key, value, process.env.WORKER_NAME || 'unknown'],
  );
}

// ================================================================
// ACTIVITY: Notify a human
// ================================================================
export async function notifyHuman(params: {
  message: string;
  workflowId: string;
}): Promise<void> {
  console.log(`\n📢 [NOTIFICATION] ${params.message}\n`);

  // Slack webhook (if configured)
  if (process.env.SLACK_WEBHOOK_URL) {
    try {
      await fetch(process.env.SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: params.message }),
      });
    } catch (err) {
      console.error('Slack notification failed:', err);
    }
  }
}

// ================================================================
// ACTIVITY: Validate identity and authorization for provisioning
// ================================================================
export async function validateProvisioningIdentity(params: {
  email: string;
  linuxUser: string;
  groups?: string[];
  requiredGroups?: string[];
  workflowId?: string;
  runId?: string;
  traceContext?: TraceContext;
}): Promise<ProvisioningIdentityResult> {
  return withTraceSpan('opencortex.provisioning.validate_identity', params.traceContext, {
    'workflow.id': params.workflowId,
    'workflow.run_id': params.runId,
    'identity.email': params.email,
    'identity.linux_user': params.linuxUser,
  }, async () => {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(params.email)) {
      throw new Error(`Invalid provisioning email: ${params.email}`);
    }
    if (!isSafeLinuxUser(params.linuxUser)) {
      throw new Error(`Invalid Linux user for provisioning: ${params.linuxUser}`);
    }

    const groups = uniqueMatches(params.groups ?? []).sort();
    const requiredGroups = uniqueMatches(params.requiredGroups ?? []).sort();
    const missingGroups = requiredGroups.filter(group => !groups.includes(group));
    if (missingGroups.length > 0) {
      throw new Error(
        `Provisioning identity ${params.email} is missing required group(s): ${missingGroups.join(', ')}`,
      );
    }

    return {
      email: params.email,
      linuxUser: params.linuxUser,
      groups,
      requiredGroups,
    };
  });
}

// ================================================================
// ACTIVITY: Run the idempotent OpenCortex user provisioner
// ================================================================
export async function runUserProvisioningScript(params: {
  linuxUser: string;
  provisionScript?: string;
  workspaceRoot?: string;
  workflowId?: string;
  runId?: string;
  traceContext?: TraceContext;
}): Promise<UserProvisioningRunResult> {
  return withTraceSpan('opencortex.provisioning.run_script', params.traceContext, {
    'workflow.id': params.workflowId,
    'workflow.run_id': params.runId,
    'identity.linux_user': params.linuxUser,
  }, async () => {
    if (!isSafeLinuxUser(params.linuxUser)) {
      throw new Error(`Invalid Linux user for provisioning: ${params.linuxUser}`);
    }
    const script =
      params.provisionScript ??
      process.env.OPENCORTEX_PROVISION_USER_SCRIPT ??
      '/opt/opencortex/scripts/provision-opencortex-user.sh';
    const output = execFileSync('sudo', ['-n', '/usr/bin/bash', script, params.linuxUser], {
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        ...(params.workspaceRoot ? { OPENCORTEX_WORKSPACE_ROOT: params.workspaceRoot } : {}),
      },
    });

    return {
      linuxUser: params.linuxUser,
      script,
      output: output.trim(),
    };
  });
}

// ================================================================
// ACTIVITY: Verify user runtime, memory, and skill directories
// ================================================================
export async function verifyProvisionedUser(params: {
  linuxUser: string;
  workspaceRoot?: string;
  homeDir?: string;
  requiredTools?: string[];
  workflowId?: string;
  runId?: string;
  traceContext?: TraceContext;
}): Promise<UserProvisioningVerificationResult> {
  return withTraceSpan('opencortex.provisioning.verify_user', params.traceContext, {
    'workflow.id': params.workflowId,
    'workflow.run_id': params.runId,
    'identity.linux_user': params.linuxUser,
  }, async () => {
    if (!isSafeLinuxUser(params.linuxUser)) {
      throw new Error(`Invalid Linux user for provisioning: ${params.linuxUser}`);
    }

    const homeDir = params.homeDir ?? `/home/${params.linuxUser}`;
    const workspaceRoot =
      params.workspaceRoot ??
      process.env.OPENCORTEX_WORKSPACE_ROOT ??
      '/srv/opencortex/workspaces';
    const workspaceDir = join(workspaceRoot, params.linuxUser);
    const skillTargetPaths = [
      join(homeDir, '.opencode', 'skills'),
      join(homeDir, '.codex', 'skills'),
    ];
    const requiredPaths = [
      homeDir,
      join(homeDir, 'repos'),
      join(workspaceDir, 'repos'),
      join(homeDir, '.config', 'opencode'),
      join(homeDir, '.config', 'gh'),
      join(homeDir, '.config', 'acli'),
      join(homeDir, '.opencortex', 'memory'),
      join(homeDir, '.opencortex', 'credentials'),
      ...skillTargetPaths,
    ];
    const missingPaths = requiredPaths.filter(path => !isDirectory(path));
    if (missingPaths.length > 0) {
      throw new Error(
        `Provisioned user ${params.linuxUser} is missing required path(s): ${missingPaths.join(', ')}`,
      );
    }

    const skillTargets = skillTargetPaths.map(path => ({
      path,
      exists: true,
      installedPackCount: countSkillPacks(path),
    }));
    const requiredTools = params.requiredTools ?? ['node', 'npm', 'git', 'opencode', 'cortex'];
    const tools = Object.fromEntries(
      requiredTools.map(tool => [tool, commandExists(tool)]),
    );
    const missingTools = Object.entries(tools)
      .filter(([, exists]) => !exists)
      .map(([tool]) => tool);
    if (missingTools.length > 0) {
      throw new Error(
        `Provisioned user ${params.linuxUser} is missing required tool(s): ${missingTools.join(', ')}`,
      );
    }

    return {
      linuxUser: params.linuxUser,
      homeDir,
      workspaceDir,
      requiredPaths,
      skillTargets,
      tools,
    };
  });
}

// ================================================================
// ACTIVITY: Start/probe/archive a runtime-backed Workbench session
// ================================================================
export async function startRuntimeWorkbenchSession(params: {
  runtimeBaseUrl?: string;
  authorizationHeader?: string;
  workflowId?: string;
  runId?: string;
  traceContext?: TraceContext;
}): Promise<RuntimeWorkbenchSessionResult> {
  return withTraceSpan('opencortex.workbench.start_session', params.traceContext, {
    'workflow.id': params.workflowId,
    'workflow.run_id': params.runId,
  }, async () => {
    const payload = await runtimeJson(params, '/runtime/code/sessions', {
      method: 'POST',
    }) as { session?: RuntimeWorkbenchSession; channel?: Record<string, unknown> };
    if (!payload.session?.id) {
      throw new Error('Runtime session start did not return a session id');
    }
    return {
      session: payload.session,
      ...(payload.channel ? { channel: payload.channel } : {}),
    };
  });
}

export async function probeRuntimeWorkbenchSession(params: {
  sessionId: string;
  runtimeBaseUrl?: string;
  authorizationHeader?: string;
  workflowId?: string;
  runId?: string;
  traceContext?: TraceContext;
}): Promise<RuntimeWorkbenchProbeResult> {
  return withTraceSpan('opencortex.workbench.probe_session', params.traceContext, {
    'workflow.id': params.workflowId,
    'workflow.run_id': params.runId,
    'workbench.session_id': params.sessionId,
  }, async () => {
    const payload = await runtimeJson(params, '/runtime/code/sessions', {
      method: 'GET',
    }) as { sessions?: RuntimeWorkbenchSession[] };
    const session = (payload.sessions ?? []).find(item => item.id === params.sessionId);
    return {
      sessionId: params.sessionId,
      running: Boolean(session),
      ...(session ? { session } : {}),
    };
  });
}

export async function archiveRuntimeWorkbenchSession(params: {
  sessionId: string;
  runtimeBaseUrl?: string;
  authorizationHeader?: string;
  workflowId?: string;
  runId?: string;
  traceContext?: TraceContext;
}): Promise<RuntimeWorkbenchSessionResult> {
  return withTraceSpan('opencortex.workbench.archive_session', params.traceContext, {
    'workflow.id': params.workflowId,
    'workflow.run_id': params.runId,
    'workbench.session_id': params.sessionId,
  }, async () => {
    const payload = await runtimeJson(
      params,
      `/runtime/code/sessions/${encodeURIComponent(params.sessionId)}`,
      { method: 'DELETE' },
      [404],
    ) as { session?: RuntimeWorkbenchSession; channel?: Record<string, unknown> };
    return {
      session: payload.session ?? { id: params.sessionId },
      ...(payload.channel ? { channel: payload.channel } : {}),
    };
  });
}

// ================================================================
// ACTIVITY: Apply pair-prompt review decisions through runtime
// ================================================================
export async function approveRuntimePairPrompt(params: {
  sessionId: string;
  draftId: string;
  runtimeBaseUrl?: string;
  authorizationHeader?: string;
  workflowId?: string;
  runId?: string;
  traceContext?: TraceContext;
}): Promise<RuntimePairPromptResult> {
  return withTraceSpan('opencortex.pair_prompt.approve_runtime', params.traceContext, {
    'workflow.id': params.workflowId,
    'workflow.run_id': params.runId,
    'workbench.session_id': params.sessionId,
    'pair_prompt.draft_id': params.draftId,
  }, async () => runtimeJson(
    params,
    `/runtime/code/sessions/${encodeURIComponent(params.sessionId)}/pair-prompts/${encodeURIComponent(params.draftId)}/approve`,
    { method: 'POST' },
    [409, 502],
  ) as Promise<RuntimePairPromptResult>);
}

export async function rejectRuntimePairPrompt(params: {
  sessionId: string;
  draftId: string;
  reason?: string;
  runtimeBaseUrl?: string;
  authorizationHeader?: string;
  workflowId?: string;
  runId?: string;
  traceContext?: TraceContext;
}): Promise<RuntimePairPromptResult> {
  return withTraceSpan('opencortex.pair_prompt.reject_runtime', params.traceContext, {
    'workflow.id': params.workflowId,
    'workflow.run_id': params.runId,
    'workbench.session_id': params.sessionId,
    'pair_prompt.draft_id': params.draftId,
  }, async () => runtimeJson(
    params,
    `/runtime/code/sessions/${encodeURIComponent(params.sessionId)}/pair-prompts/${encodeURIComponent(params.draftId)}/reject`,
    {
      method: 'POST',
      body: JSON.stringify({ reason: params.reason }),
      headers: { 'Content-Type': 'application/json' },
    },
  ) as Promise<RuntimePairPromptResult>);
}

// ================================================================
// ACTIVITY: Scan filesystem artifacts for ArtifactSyncWorkflow
// ================================================================
export async function scanArtifactFiles(params: {
  rootDir: string;
  sourceSystem: string;
  includeExtensions?: string[];
  excludeDirs?: string[];
  maxFiles?: number;
  maxBytes?: number;
  traceContext?: TraceContext;
}): Promise<{ rootDir: string; files: ArtifactSyncFile[] }> {
  return withTraceSpan('opencortex.artifact_sync.scan_files', params.traceContext, {
    'artifact_sync.root_dir': params.rootDir,
    'artifact_sync.source_system': params.sourceSystem,
  }, async () => {
    const rootDir = params.rootDir;
    if (!existsSync(rootDir) || !statSync(rootDir).isDirectory()) {
      throw new Error(`Artifact sync root is not a directory: ${rootDir}`);
    }
    const maxFiles = params.maxFiles ?? 200;
    const maxBytes = params.maxBytes ?? 1024 * 1024;
    const includeExtensions = new Set(
      (params.includeExtensions ?? ['.md', '.markdown', '.txt', '.log', '.json', '.jsonl', '.yaml', '.yml'])
        .map(value => value.toLowerCase()),
    );
    const excludeDirs = new Set(params.excludeDirs ?? [
      '.git',
      'node_modules',
      'dist',
      'build',
      '.next',
      '.turbo',
    ]);
    const files: ArtifactSyncFile[] = [];
    const stack = [rootDir];

    while (stack.length > 0 && files.length < maxFiles) {
      const dir = stack.pop()!;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') && entry.name !== '.opencortex') {
          continue;
        }
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!excludeDirs.has(entry.name)) {
            stack.push(path);
          }
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        const extension = fileExtension(entry.name);
        if (!includeExtensions.has(extension)) {
          continue;
        }
        const stat = statSync(path);
        if (stat.size > maxBytes) {
          continue;
        }
        let content: string;
        try {
          content = readFileSync(path, 'utf8');
        } catch {
          continue;
        }
        const sourcePath = relative(rootDir, path) || entry.name;
        files.push({
          artifactName: entry.name,
          sourcePath,
          content,
          sha256: sha256Hex(content),
          sizeBytes: Buffer.byteLength(content, 'utf8'),
          mimeType: inferMimeType(entry.name),
          modifiedAt: stat.mtime.toISOString(),
        });
        if (files.length >= maxFiles) {
          break;
        }
      }
    }

    return { rootDir, files };
  });
}

export async function upsertArtifactSyncState(params: {
  sourceSystem: string;
  ownerId: string;
  status: 'running' | 'ok' | 'failed';
  project?: string;
  repo?: string;
  lastCursor?: string;
  stats?: Record<string, unknown>;
  error?: string;
  traceContext?: TraceContext;
}): Promise<void> {
  return withTraceSpan('opencortex.artifact_sync.upsert_state', params.traceContext, {
    'artifact_sync.source_system': params.sourceSystem,
    'artifact_sync.owner_id': params.ownerId,
    'artifact_sync.status': params.status,
  }, async () => {
    const existing = await memoryPool().query<{ id: string }>(
      `
        SELECT id
        FROM sync_state
        WHERE source_system = $1
          AND owner_id = $2
          AND project IS NOT DISTINCT FROM $3
          AND repo IS NOT DISTINCT FROM $4
        LIMIT 1
      `,
      [params.sourceSystem, params.ownerId, params.project ?? null, params.repo ?? null],
    );

    if (existing.rows[0]?.id) {
      await memoryPool().query(
        `
          UPDATE sync_state
          SET last_cursor = $2,
              last_run_at = now(),
              status = $3,
              stats = $4,
              error = $5
          WHERE id = $1
        `,
        [
          existing.rows[0].id,
          params.lastCursor ?? null,
          params.status,
          params.stats ?? {},
          params.error ?? null,
        ],
      );
      return;
    }

    await memoryPool().query(
      `
        INSERT INTO sync_state (
          source_system, owner_id, project, repo, last_cursor, last_run_at,
          status, stats, error
        )
        VALUES ($1, $2, $3, $4, $5, now(), $6, $7, $8)
      `,
      [
        params.sourceSystem,
        params.ownerId,
        params.project ?? null,
        params.repo ?? null,
        params.lastCursor ?? null,
        params.status,
        params.stats ?? {},
        params.error ?? null,
      ],
    );
  });
}

// ================================================================
// ACTIVITY: Store original artifact for MemoryIngestWorkflow
// ================================================================
export async function storeOriginalArtifact(params: {
  content: string;
  artifactName: string;
  ownerId: string;
  sourceSystem: string;
  workflowId: string;
  runId: string;
  sourceSessionId?: string;
  project?: string;
  repo?: string;
  scope?: 'personal' | 'team' | 'global';
  toolName?: string;
  mimeType?: string;
  sourcePath?: string;
  identitySubject?: string;
  traceContext?: TraceContext;
}): Promise<StoredArtifact> {
  return withTraceSpan('opencortex.memory.store_original_artifact', params.traceContext, {
    'workflow.id': params.workflowId,
    'workflow.run_id': params.runId,
    'memory.owner_id': params.ownerId,
    'memory.source_system': params.sourceSystem,
  }, async () => {
  const sourcePath = params.sourcePath ?? params.artifactName;
  const sha256 = sha256Hex(params.content);
  const existing = await findArtifact(params.sourceSystem, sourcePath, sha256);
  if (existing) {
    return existing;
  }

  const storageKey = objectStorageKey({
    ownerId: params.ownerId,
    project: params.project,
    sourceSystem: params.sourceSystem,
    artifactName: params.artifactName,
    sha256,
  });
  const storageUri = `file://${join(OBJECTS_LOCAL_DIR, storageKey)}`;
  const objectPath = join(OBJECTS_LOCAL_DIR, storageKey);
  mkdirSync(dirname(objectPath), { recursive: true });
  writeFileSync(objectPath, params.content, { encoding: 'utf8' });

  const mimeType = params.mimeType ?? inferMimeType(params.artifactName);
  let insert: pg.QueryResult<ArtifactRow>;
  try {
    insert = await memoryPool().query<ArtifactRow>(
      `
        INSERT INTO artifacts (
          source_system, source_path, source_session_id, project, repo,
          session_group, scope, owner_id, identity_subject, sha256, size_bytes,
          mime_type, storage_uri, storage_key, tool_name, meta
        )
        VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10, $11,
          $12, $13, $14, $15, $16
        )
        RETURNING id, sha256, size_bytes, mime_type, storage_uri, storage_key, source_path
      `,
      [
        params.sourceSystem,
        sourcePath,
        params.sourceSessionId ?? null,
        params.project ?? null,
        params.repo ?? null,
        params.sourceSessionId ?? null,
        params.scope ?? 'personal',
        params.ownerId,
        params.identitySubject ?? null,
        sha256,
        Buffer.byteLength(params.content, 'utf8'),
        mimeType,
        storageUri,
        storageKey,
        params.toolName ?? null,
        {
          artifactName: params.artifactName,
          workflowId: params.workflowId,
          runId: params.runId,
          objectStore: {
            kind: 'local-file',
            bucket: OBJECTS_BUCKET,
            baseDir: OBJECTS_LOCAL_DIR,
          },
        },
      ],
    );
  } catch (error) {
    const raced = await findArtifact(params.sourceSystem, sourcePath, sha256);
    if (raced) {
      return raced;
    }
    throw new Error(`Artifact insert failed: ${errorMessage(error)}`);
  }

  return artifactRowToStored(insert.rows[0]);
  });
}

// ================================================================
// ACTIVITY: Extract text from artifact
// ================================================================
export async function extractArtifactText(params: {
  content: string;
  artifactId: string;
  mimeType?: string;
  workflowId?: string;
  runId?: string;
  traceContext?: TraceContext;
}): Promise<{ artifactId: string; text: string }> {
  return withTraceSpan('opencortex.memory.extract_artifact_text', params.traceContext, {
    'workflow.id': params.workflowId,
    'workflow.run_id': params.runId,
    'memory.artifact_id': params.artifactId,
  }, async () => {
  const normalized = params.content
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
    .trim();
  return {
    artifactId: params.artifactId,
    text: normalized,
  };
  });
}

// ================================================================
// ACTIVITY: Chunk extracted text
// ================================================================
export async function chunkArtifactText(params: {
  text: string;
  artifactId: string;
  maxChars?: number;
  workflowId?: string;
  runId?: string;
  traceContext?: TraceContext;
}): Promise<{ artifactId: string; chunks: TextChunk[] }> {
  return withTraceSpan('opencortex.memory.chunk_artifact_text', params.traceContext, {
    'workflow.id': params.workflowId,
    'workflow.run_id': params.runId,
    'memory.artifact_id': params.artifactId,
  }, async () => {
  const maxChars = params.maxChars ?? 4000;
  const paragraphs = params.text.split(/\n{2,}/);
  const chunks: TextChunk[] = [];
  let current = '';
  let heading: string | undefined;

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) {
      continue;
    }
    if (/^#{1,6}\s+\S/.test(trimmed)) {
      heading = trimmed.replace(/^#{1,6}\s+/, '').slice(0, 160);
    }
    if (current && current.length + trimmed.length + 2 > maxChars) {
      chunks.push({ index: chunks.length, content: current, ...(heading ? { heading } : {}) });
      current = '';
    }
    if (trimmed.length > maxChars) {
      for (let offset = 0; offset < trimmed.length; offset += maxChars) {
        chunks.push({
          index: chunks.length,
          content: trimmed.slice(offset, offset + maxChars),
          ...(heading ? { heading } : {}),
        });
      }
      continue;
    }
    current = current ? `${current}\n\n${trimmed}` : trimmed;
  }

  if (current) {
    chunks.push({ index: chunks.length, content: current, ...(heading ? { heading } : {}) });
  }

  if (chunks.length === 0) {
    chunks.push({ index: 0, content: params.text || '(empty artifact)' });
  }

  return { artifactId: params.artifactId, chunks };
  });
}

// ================================================================
// ACTIVITY: Embed and insert memory chunks
// ================================================================
export async function writeMemoryChunks(params: {
  artifact: StoredArtifact;
  chunks: TextChunk[];
  ownerId: string;
  sourceSystem: string;
  workflowId: string;
  runId: string;
  project?: string;
  repo?: string;
  scope?: 'personal' | 'team' | 'global';
  sourceSessionId?: string;
  toolName?: string;
  identitySubject?: string;
  traceContext?: TraceContext;
}): Promise<{ entryIds: string[] }> {
  return withTraceSpan('opencortex.memory.write_memory_chunks', params.traceContext, {
    'workflow.id': params.workflowId,
    'workflow.run_id': params.runId,
    'memory.artifact_id': params.artifact.artifactId,
    'memory.chunk_count': params.chunks.length,
  }, async () => {
  const entryIds: string[] = [];

  for (const chunk of params.chunks) {
    const contentHash = sha256Hex(`${params.artifact.sha256}:${chunk.index}:${chunk.content}`);
    const existing = await memoryPool().query<{ id: string }>(
      'SELECT id FROM entries WHERE content_hash = $1 AND owner_id = $2 LIMIT 1',
      [contentHash, params.ownerId],
    );
    if (existing.rows[0]?.id) {
      entryIds.push(existing.rows[0].id);
      continue;
    }

    const embedding = await getEmbedding(chunk.content);
    const inserted = await memoryPool().query<{ id: string }>(
      `
        INSERT INTO entries (
          content, title, embedding, kind, chunk_index, heading, project,
          scope, owner_id, identity_subject, author, content_hash,
          source_system, source_session_id, repo, tool_name, meta
        )
        VALUES (
          $1, $2, $3::vector, 'chunk', $4, $5, $6,
          $7, $8, $9, 'agent', $10,
          $11, $12, $13, $14, $15
        )
        RETURNING id
      `,
      [
        chunk.content,
        `${params.artifact.sourcePath}#${chunk.index + 1}`,
        vectorLiteral(embedding),
        chunk.index,
        chunk.heading ?? null,
        params.project ?? null,
        params.scope ?? 'personal',
        params.ownerId,
        params.identitySubject ?? null,
        contentHash,
        params.sourceSystem,
        params.sourceSessionId ?? null,
        params.repo ?? null,
        params.toolName ?? null,
        {
          artifactId: params.artifact.artifactId,
          artifactSha256: params.artifact.sha256,
          workflowId: params.workflowId,
          runId: params.runId,
          storageUri: params.artifact.storageUri,
        },
      ],
    );
    entryIds.push(inserted.rows[0].id);
  }

  return { entryIds };
  });
}

// ================================================================
// ACTIVITY: Link artifact to memory entries
// ================================================================
export async function linkArtifactEntries(params: {
  artifactId: string;
  entryIds: string[];
  ownerId: string;
  workflowId: string;
  runId: string;
  traceContext?: TraceContext;
}): Promise<void> {
  return withTraceSpan('opencortex.memory.link_artifact_entries', params.traceContext, {
    'workflow.id': params.workflowId,
    'workflow.run_id': params.runId,
    'memory.artifact_id': params.artifactId,
    'memory.entry_count': params.entryIds.length,
  }, async () => {
  for (const entryId of params.entryIds) {
    await memoryPool().query(
      `
        INSERT INTO artifact_links (artifact_id, entry_id, relationship, owner_id, meta)
        SELECT $1, $2, 'indexed_by', $3, $4
        WHERE NOT EXISTS (
          SELECT 1
          FROM artifact_links
          WHERE artifact_id = $1 AND entry_id = $2 AND relationship = 'indexed_by'
        )
      `,
      [
        params.artifactId,
        entryId,
        params.ownerId,
        {
          workflowId: params.workflowId,
          runId: params.runId,
        },
      ],
    );
  }
  });
}

// ================================================================
// ACTIVITY: Write ingest audit event
// ================================================================
export async function writeIngestAuditEvent(params: {
  artifactId: string;
  entryIds: string[];
  ownerId: string;
  sourceSystem: string;
  workflowId: string;
  runId: string;
  project?: string;
  sourceSessionId?: string;
  identitySubject?: string;
  traceContext?: TraceContext;
}): Promise<{ logId: string }> {
  return withTraceSpan('opencortex.memory.write_ingest_audit_event', params.traceContext, {
    'workflow.id': params.workflowId,
    'workflow.run_id': params.runId,
    'memory.artifact_id': params.artifactId,
    'memory.entry_count': params.entryIds.length,
  }, async () => {
  const existing = await memoryPool().query<{ id: string }>(
    `
      SELECT id
      FROM log
      WHERE kind = 'ingest'
        AND owner_id = $1
        AND data @> $2::jsonb
      LIMIT 1
    `,
    [params.ownerId, JSON.stringify({ workflowId: params.workflowId })],
  );
  if (existing.rows[0]?.id) {
    return { logId: existing.rows[0].id };
  }

  const inserted = await memoryPool().query<{ id: string }>(
    `
      INSERT INTO log (
        kind, status, summary, project, owner_id, identity_subject,
        worker, data, entry_id
      )
      VALUES ('ingest', 'pass', $1, $2, $3, $4, $5, $6, $7)
      RETURNING id
    `,
    [
      `Ingested artifact ${params.artifactId} into ${params.entryIds.length} memory chunk(s)`,
      params.project ?? null,
      params.ownerId,
      params.identitySubject ?? null,
      process.env.WORKER_NAME || 'opencortex-orchestrator',
      {
        artifactId: params.artifactId,
        entryIds: params.entryIds,
        sourceSystem: params.sourceSystem,
        sourceSessionId: params.sourceSessionId ?? null,
        workflowId: params.workflowId,
        runId: params.runId,
      },
      params.entryIds[0] ?? null,
    ],
  );
  return { logId: inserted.rows[0].id };
  });
}

// ================================================================
// ACTIVITY: Populate rebuildable workflow projection
// ================================================================
export async function upsertWorkflowProjection(params: {
  workflowId: string;
  runId: string;
  workflowType: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  ownerId: string;
  summary: string;
  project?: string;
  sourceSystem?: string;
  sourceSessionId?: string;
  artifactId?: string;
  entryIds?: string[];
  data?: Record<string, unknown>;
  traceContext?: TraceContext;
}): Promise<void> {
  return withTraceSpan('opencortex.memory.upsert_workflow_projection', params.traceContext, {
    'workflow.id': params.workflowId,
    'workflow.run_id': params.runId,
    'workflow.type': params.workflowType,
    'workflow.status': params.status,
  }, async () => {
  await memoryPool().query(
    `
      INSERT INTO workflow_projection (
        workflow_id, run_id, workflow_type, status, owner_id, project,
        source_system, source_session_id, artifact_id, entry_ids, summary,
        data, started_at, completed_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11,
        $12, now(), $13
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
      params.workflowId,
      params.runId,
      params.workflowType,
      params.status,
      params.ownerId,
      params.project ?? null,
      params.sourceSystem ?? null,
      params.sourceSessionId ?? null,
      params.artifactId ?? null,
      params.entryIds ?? [],
      params.summary,
      params.data ?? {},
      params.status === 'completed' ? new Date().toISOString() : null,
    ],
  );
  });
}

// ================================================================
// ACTIVITY: Apply a workflow-driven memory review decision
// ================================================================
export async function updateMemoryEntryReview(params: {
  entryId: string;
  ownerId: string;
  review: MemoryEntryReview;
  reviewerEmail?: string;
  notes?: string;
  workflowId?: string;
  runId?: string;
  traceContext?: TraceContext;
}): Promise<ReviewMemoryEntryResult> {
  return withTraceSpan('opencortex.memory.review_entry', params.traceContext, {
    'memory.entry_id': params.entryId,
    'memory.review': params.review,
    'workflow.id': params.workflowId,
    'workflow.run_id': params.runId,
  }, async () => {
    const updated = await memoryPool().query<{
      id: string;
      owner_id: string;
      project: string | null;
      review: MemoryEntryReview;
    }>(
      `
        UPDATE entries
        SET review = $1
        WHERE id = $2 AND owner_id = $3
        RETURNING id, owner_id, project, review
      `,
      [params.review, params.entryId, params.ownerId],
    );

    if (!updated.rows[0]) {
      throw new Error(`Memory review update failed: entry ${params.entryId} not found`);
    }

    await memoryPool().query(
      `
        INSERT INTO log (
          kind, status, summary, project, owner_id, entry_id, worker, data
        )
        VALUES ('review', 'pass', $1, $2, $3, $4, $5, $6)
      `,
      [
        `Reviewed memory entry ${params.entryId}: ${params.review}`,
        updated.rows[0].project ?? null,
        params.ownerId,
        params.entryId,
        process.env.WORKER_NAME || 'opencortex-orchestrator',
        {
          review: params.review,
          reviewerEmail: params.reviewerEmail ?? params.ownerId,
          notes: params.notes ?? null,
          workflowId: params.workflowId ?? null,
          runId: params.runId ?? null,
        },
      ],
    );

    return {
      entryId: updated.rows[0].id,
      ownerId: updated.rows[0].owner_id,
      project: updated.rows[0].project ?? undefined,
      review: updated.rows[0].review,
    };
  });
}

// ================================================================
// Helpers
// ================================================================
async function getEmbedding(text: string): Promise<number[]> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (EMBEDDINGS_KEY) {
    headers.Authorization = `Bearer ${EMBEDDINGS_KEY}`;
  }

  const r = await fetch(EMBEDDINGS_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: EMBEDDINGS_MODEL,
      input: text,
      dimensions: EMBEDDINGS_DIMENSIONS,
    }),
  });

  if (!r.ok) {
    const msg = await r.text().catch(() => '');
    throw new Error(`Embedding failed: ${r.status} ${msg}`);
  }

  const d = await r.json() as EmbeddingResponse;
  const embedding = d.data[0]?.embedding;
  if (!embedding?.length) {
    throw new Error('Embedding failed: response did not include an embedding');
  }
  return embedding;
}

async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  return {
    people: extractPeople(text),
    action_items: extractActionItems(text),
    dates_mentioned: extractDates(text),
    topics: extractTopics(text),
    type: inferMemoryType(text),
  };
}

function extractPeople(text: string): string[] {
  return uniqueMatches(text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g) ?? [])
    .filter(name => !['Open Cortex', 'Cortex Memory'].includes(name))
    .slice(0, 5);
}

function extractActionItems(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(line => line.trim().replace(/^[-*]\s+/, ''))
    .filter(line => /^(todo|fixme|action|next|follow up|follow-up)\b/i.test(line))
    .slice(0, 5);
}

function extractDates(text: string): string[] {
  return uniqueMatches(text.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? []).slice(0, 5);
}

function extractTopics(text: string): string[] {
  const lower = text.toLowerCase();
  const topicRules: Array<[string, RegExp]> = [
    ['authentication', /\b(auth|oidc|dex|login|session|token)\b/],
    ['memory', /\b(memory|embedding|recall|search|thought|artifact)\b/],
    ['workflow', /\b(workflow|temporal|activity|signal|approval)\b/],
    ['deployment', /\b(deploy|podman|quadlet|systemd|container)\b/],
    ['skills', /\b(skill|bundle|provision)\b/],
    ['testing', /\b(test|spec|regression|coverage|validate)\b/],
  ];
  const topics = topicRules
    .filter(([, pattern]) => pattern.test(lower))
    .map(([topic]) => topic);

  return topics.length > 0 ? topics.slice(0, 3) : ['uncategorized'];
}

function inferMemoryType(text: string): string {
  if (/^(todo|fixme|action|next|follow up|follow-up)\b/im.test(text)) {
    return 'task';
  }
  if (/\b(idea|proposal|consider|maybe)\b/i.test(text)) {
    return 'idea';
  }
  if (/\bhttps?:\/\/\S+/i.test(text)) {
    return 'reference';
  }
  if (extractPeople(text).length > 0) {
    return 'person_note';
  }
  return 'observation';
}

function uniqueMatches(values: string[]): string[] {
  return [...new Set(values)];
}

function isSafeLinuxUser(value: string): boolean {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(value)) {
    return false;
  }
  return ![
    'root',
    'admin',
    'administrator',
    'daemon',
    'bin',
    'sys',
    'sync',
    'diwan',
    'opencortex',
    'ssm-user',
    'ubuntu',
    'ec2-user',
    'nobody',
    'sshd',
    'www-data',
  ].includes(value);
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function countSkillPacks(path: string): number {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .length;
  } catch {
    return 0;
  }
}

function commandExists(command: string): boolean {
  if (!/^[A-Za-z0-9_.@+-]+$/.test(command)) {
    return false;
  }
  try {
    execFileSync('/usr/bin/env', ['which', command], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

async function runtimeJson(
  params: { runtimeBaseUrl?: string; authorizationHeader?: string },
  path: string,
  init: RequestInit,
  okStatuses: number[] = [],
): Promise<unknown> {
  const configuredBaseUrl = (
    params.runtimeBaseUrl ??
    process.env.OPENCORTEX_RUNTIME_API_BASE_URL ??
    process.env.OPENCORTEX_RUNTIME_BASE_URL ??
    'http://127.0.0.1:8080/api'
  ).replace(/\/$/, '');
  const baseUrl = configuredBaseUrl.endsWith('/api')
    ? configuredBaseUrl
    : `${configuredBaseUrl}/api`;
  const authorization =
    params.authorizationHeader ??
    process.env.OPENCORTEX_RUNTIME_AUTH_HEADER ??
    '';
  if (!authorization) {
    throw new Error('Set OPENCORTEX_RUNTIME_AUTH_HEADER or pass authorizationHeader');
  }
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) as unknown : {};
  if (!response.ok && !okStatuses.includes(response.status)) {
    const message =
      payload && typeof payload === 'object' && 'message' in payload
        ? String((payload as { message?: unknown }).message)
        : text;
    throw new Error(`Runtime API ${init.method ?? 'GET'} ${path} failed: ${response.status} ${message}`);
  }
  return payload;
}

async function findArtifact(
  sourceSystem: string,
  sourcePath: string,
  sha256: string,
): Promise<StoredArtifact | undefined> {
  const existing = await memoryPool().query<ArtifactRow>(
    `
      SELECT id, sha256, size_bytes, mime_type, storage_uri, storage_key, source_path
      FROM artifacts
      WHERE source_system = $1 AND source_path = $2 AND sha256 = $3
      LIMIT 1
    `,
    [sourceSystem, sourcePath, sha256],
  );

  return existing.rows[0] ? artifactRowToStored(existing.rows[0]) : undefined;
}

type ArtifactRow = {
  id: string;
  sha256: string;
  size_bytes: number;
  mime_type: string | null;
  storage_uri: string | null;
  storage_key: string | null;
  source_path: string;
};

function artifactRowToStored(row: ArtifactRow): StoredArtifact {
  return {
    artifactId: row.id,
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes),
    mimeType: row.mime_type ?? 'text/plain',
    storageUri: row.storage_uri ?? '',
    storageKey: row.storage_key ?? '',
    sourcePath: row.source_path,
  };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function vectorLiteral(values: number[]): string {
  if (values.length !== EMBEDDINGS_DIMENSIONS) {
    throw new Error(
      `Embedding dimension mismatch: expected ${EMBEDDINGS_DIMENSIONS}, got ${values.length}`,
    );
  }
  return `[${values.join(',')}]`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function objectStorageKey(params: {
  ownerId: string;
  project?: string;
  sourceSystem: string;
  artifactName: string;
  sha256: string;
}): string {
  const project = params.project ? safeObjectPathPart(params.project) : 'unscoped';
  const sourceSystem = safeObjectPathPart(params.sourceSystem);
  const ownerId = safeObjectPathPart(params.ownerId);
  const artifactName = safeObjectPathPart(params.artifactName);
  return [
    safeObjectPathPart(OBJECTS_PREFIX),
    ownerId,
    project,
    sourceSystem,
    `${params.sha256}-${artifactName}`,
  ].join('/');
}

function safeObjectPathPart(value: string): string {
  return value
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .join('-')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 180) || 'unnamed';
}

function inferMimeType(name: string): string {
  if (/\.(md|markdown|txt|log|jsonl?|ya?ml)$/i.test(name)) {
    return 'text/plain';
  }
  return 'application/octet-stream';
}

function fileExtension(name: string): string {
  const match = /\.[^.]+$/.exec(name);
  return match?.[0]?.toLowerCase() ?? '';
}

function firstLineTitle(content: string): string {
  const first = content
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean);
  return (first ?? 'Memory capture').slice(0, 160);
}
