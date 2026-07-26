import { Context } from '@temporalio/activity';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { execFileSync } from 'child_process';

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

type EmbeddingResponse = {
  data: Array<{ embedding: number[] }>;
};

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

  const { data, error } = await supabase().rpc('match_thoughts', {
    query_embedding: embedding,
    match_threshold: 0.4,
    match_count: 5,
    filter: {},
  });

  if (error || !data?.length) return 'No relevant memory context found.';

  return data
    .map((t: any, i: number) =>
      `[${i + 1}] (${(t.similarity * 100).toFixed(0)}% match, ` +
      `${new Date(t.created_at).toLocaleDateString()})\n${t.content}`
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

  const { error } = await supabase().from('thoughts').insert({
    content,
    embedding,
    metadata: { ...metadata, source: 'opencortex' },
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
