import { Context } from '@temporalio/activity';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { TraceContext, withTraceSpan } from '../telemetry';

// --- Shared memory client ---
let _supabase: SupabaseClient;
function supabase(): SupabaseClient {
  if (!_supabase) {
    _supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _supabase;
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

  const { data, error } = await supabase().rpc('search', {
    q: query,
    q_embedding: embedding,
    caller: ownerId,
    n: 5,
    include_pending: true,
  });

  if (error || !data?.length) return 'No relevant memory context found.';

  return data
    .map((t: any, i: number) =>
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

  const existing = await supabase()
    .from('entries')
    .select('id')
    .eq('content_hash', contentHash)
    .eq('owner_id', ownerId)
    .maybeSingle();

  if (existing.error) {
    console.error('Failed to lookup memory capture:', existing.error.message);
    return;
  }
  if (existing.data?.id) {
    return;
  }

  const { error } = await supabase()
    .from('entries')
    .insert({
      content,
      title: firstLineTitle(content),
      embedding,
      kind: 'thought',
      scope: 'team',
      owner_id: ownerId,
      author: 'agent',
      content_hash: contentHash,
      source_system: 'opencortex',
      meta: { ...metadata, source: 'opencortex' },
    });

  if (error) {
    console.error('Failed to capture to memory:', error.message);
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
  const { data: existing } = await supabase()
    .from('task_ledger')
    .select('id')
    .eq('temporal_workflow_id', params.workflowId)
    .maybeSingle();

  if (existing) {
    await supabase()
      .from('task_ledger')
      .update({
        status: params.status,
        output: params.output || {},
        completed_at: ['completed', 'failed', 'cancelled'].includes(params.status)
          ? new Date().toISOString()
          : undefined,
      })
      .eq('temporal_workflow_id', params.workflowId);
  } else {
    await supabase().from('task_ledger').insert({
      temporal_workflow_id: params.workflowId,
      task_type: params.taskType || 'custom',
      status: params.status,
      input: params.input || {},
      started_at: new Date().toISOString(),
    });
  }
}

// ================================================================
// ACTIVITY: Get/Set shared workflow context
// ================================================================
export async function getWorkflowContext(
  workflowId: string,
  key: string
): Promise<any> {
  const { data } = await supabase()
    .from('workflow_context')
    .select('context_value')
    .eq('workflow_id', workflowId)
    .eq('context_key', key)
    .maybeSingle();
  return data?.context_value;
}

export async function setWorkflowContext(
  workflowId: string,
  key: string,
  value: any
): Promise<void> {
  await supabase().from('workflow_context').upsert(
    {
      workflow_id: workflowId,
      context_key: key,
      context_value: value,
      updated_by: process.env.WORKER_NAME || 'unknown',
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'workflow_id,context_key' }
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
  const insert = await supabase()
    .from('artifacts')
    .insert({
      source_system: params.sourceSystem,
      source_path: sourcePath,
      source_session_id: params.sourceSessionId ?? null,
      project: params.project ?? null,
      repo: params.repo ?? null,
      session_group: params.sourceSessionId ?? null,
      scope: params.scope ?? 'personal',
      owner_id: params.ownerId,
      identity_subject: params.identitySubject ?? null,
      sha256,
      size_bytes: Buffer.byteLength(params.content, 'utf8'),
      mime_type: mimeType,
      storage_uri: storageUri,
      storage_key: storageKey,
      tool_name: params.toolName ?? null,
      meta: {
        artifactName: params.artifactName,
        workflowId: params.workflowId,
        runId: params.runId,
        objectStore: {
          kind: 'local-file',
          bucket: OBJECTS_BUCKET,
          baseDir: OBJECTS_LOCAL_DIR,
        },
      },
    })
    .select('id,sha256,size_bytes,mime_type,storage_uri,storage_key,source_path')
    .single();

  if (insert.error) {
    const raced = await findArtifact(params.sourceSystem, sourcePath, sha256);
    if (raced) {
      return raced;
    }
    throw new Error(`Artifact insert failed: ${insert.error.message}`);
  }

  return artifactRowToStored(insert.data);
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
    const existing = await supabase()
      .from('entries')
      .select('id')
      .eq('content_hash', contentHash)
      .eq('owner_id', params.ownerId)
      .maybeSingle();
    if (existing.error) {
      throw new Error(`Entry lookup failed: ${existing.error.message}`);
    }
    if (existing.data?.id) {
      entryIds.push(existing.data.id);
      continue;
    }

    const embedding = await getEmbedding(chunk.content);
    const inserted = await supabase()
      .from('entries')
      .insert({
        content: chunk.content,
        title: `${params.artifact.sourcePath}#${chunk.index + 1}`,
        embedding,
        kind: 'chunk',
        chunk_index: chunk.index,
        heading: chunk.heading ?? null,
        project: params.project ?? null,
        scope: params.scope ?? 'personal',
        owner_id: params.ownerId,
        identity_subject: params.identitySubject ?? null,
        author: 'agent',
        content_hash: contentHash,
        source_system: params.sourceSystem,
        source_session_id: params.sourceSessionId ?? null,
        repo: params.repo ?? null,
        tool_name: params.toolName ?? null,
        meta: {
          artifactId: params.artifact.artifactId,
          artifactSha256: params.artifact.sha256,
          workflowId: params.workflowId,
          runId: params.runId,
          storageUri: params.artifact.storageUri,
        },
      })
      .select('id')
      .single();

    if (inserted.error) {
      throw new Error(`Entry insert failed: ${inserted.error.message}`);
    }
    entryIds.push(inserted.data.id);
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
    const existing = await supabase()
      .from('artifact_links')
      .select('id')
      .eq('artifact_id', params.artifactId)
      .eq('entry_id', entryId)
      .eq('relationship', 'indexed_by')
      .maybeSingle();
    if (existing.error) {
      throw new Error(`Artifact link lookup failed: ${existing.error.message}`);
    }
    if (existing.data?.id) {
      continue;
    }
    const inserted = await supabase()
      .from('artifact_links')
      .insert({
        artifact_id: params.artifactId,
        entry_id: entryId,
        relationship: 'indexed_by',
        owner_id: params.ownerId,
        meta: {
          workflowId: params.workflowId,
          runId: params.runId,
        },
      });
    if (inserted.error) {
      throw new Error(`Artifact link insert failed: ${inserted.error.message}`);
    }
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
  const existing = await supabase()
    .from('log')
    .select('id')
    .eq('kind', 'ingest')
    .eq('owner_id', params.ownerId)
    .contains('data', { workflowId: params.workflowId })
    .maybeSingle();
  if (existing.error) {
    throw new Error(`Ingest audit lookup failed: ${existing.error.message}`);
  }
  if (existing.data?.id) {
    return { logId: existing.data.id };
  }

  const inserted = await supabase()
    .from('log')
    .insert({
      kind: 'ingest',
      status: 'pass',
      summary: `Ingested artifact ${params.artifactId} into ${params.entryIds.length} memory chunk(s)`,
      project: params.project ?? null,
      owner_id: params.ownerId,
      identity_subject: params.identitySubject ?? null,
      worker: process.env.WORKER_NAME || 'opencortex-orchestrator',
      data: {
        artifactId: params.artifactId,
        entryIds: params.entryIds,
        sourceSystem: params.sourceSystem,
        sourceSessionId: params.sourceSessionId ?? null,
        workflowId: params.workflowId,
        runId: params.runId,
      },
      entry_id: params.entryIds[0] ?? null,
    })
    .select('id')
    .single();

  if (inserted.error) {
    throw new Error(`Ingest audit insert failed: ${inserted.error.message}`);
  }
  return { logId: inserted.data.id };
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
  const upserted = await supabase()
    .from('workflow_projection')
    .upsert(
      {
        workflow_id: params.workflowId,
        run_id: params.runId,
        workflow_type: params.workflowType,
        status: params.status,
        owner_id: params.ownerId,
        project: params.project ?? null,
        source_system: params.sourceSystem ?? null,
        source_session_id: params.sourceSessionId ?? null,
        artifact_id: params.artifactId ?? null,
        entry_ids: params.entryIds ?? [],
        summary: params.summary,
        data: params.data ?? {},
        completed_at: params.status === 'completed' ? new Date().toISOString() : null,
      },
      { onConflict: 'workflow_id' },
    );

  if (upserted.error) {
    throw new Error(`Workflow projection upsert failed: ${upserted.error.message}`);
  }
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
  const existing = await supabase()
    .from('artifacts')
    .select('id,sha256,size_bytes,mime_type,storage_uri,storage_key,source_path')
    .eq('source_system', sourceSystem)
    .eq('source_path', sourcePath)
    .eq('sha256', sha256)
    .maybeSingle();

  if (existing.error) {
    throw new Error(`Artifact lookup failed: ${existing.error.message}`);
  }
  return existing.data ? artifactRowToStored(existing.data) : undefined;
}

function artifactRowToStored(row: {
  id: string;
  sha256: string;
  size_bytes: number;
  mime_type: string | null;
  storage_uri: string | null;
  storage_key: string | null;
  source_path: string;
}): StoredArtifact {
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

function firstLineTitle(content: string): string {
  const first = content
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean);
  return (first ?? 'Memory capture').slice(0, 160);
}
