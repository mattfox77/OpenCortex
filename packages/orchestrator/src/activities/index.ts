import { Context } from '@temporalio/activity';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { execSync } from 'child_process';

// --- Shared Supabase client ---
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

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY!;
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

type EmbeddingResponse = {
  data: Array<{ embedding: number[] }>;
};

type ChatCompletionResponse = {
  choices: Array<{ message: { content: string } }>;
};

// ================================================================
// ACTIVITY: Execute a CLI command via Claude Code
// ================================================================
export async function executeCliCommand(params: {
  prompt: string;
  cwd?: string;
}): Promise<string> {
  const ctx = Context.current();

  // Heartbeat so Temporal knows we're alive during long CLI runs
  const hb = setInterval(() => ctx.heartbeat('running CLI...'), 10_000);

  try {
    // Escape the prompt for shell
    const escaped = params.prompt
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/`/g, '\\`')
      .replace(/\$/g, '\\$');

    const result = execSync(
      `claude --print "${escaped}"`,
      {
        cwd: params.cwd || process.cwd(),
        timeout: 600_000, // 10 min
        maxBuffer: 10 * 1024 * 1024, // 10 MB
        encoding: 'utf-8',
        env: { ...process.env },
      }
    );
    return result.trim();
  } catch (err: any) {
    // If Claude Code isn't installed, fall back to a helpful error
    if (err.message?.includes('not found') || err.message?.includes('ENOENT')) {
      throw new Error(
        'Claude Code CLI not found. Install with: npm install -g @anthropic-ai/claude-code'
      );
    }
    // Return stderr as output if the command itself failed
    return err.stderr?.toString() || err.message || 'CLI command failed';
  } finally {
    clearInterval(hb);
  }
}

// ================================================================
// ACTIVITY: Search Open Brain
// ================================================================
export async function searchBrain(query: string): Promise<string> {
  const embedding = await getEmbedding(query);

  const { data, error } = await supabase().rpc('match_thoughts', {
    query_embedding: embedding,
    match_threshold: 0.4,
    match_count: 5,
    filter: {},
  });

  if (error || !data?.length) return 'No relevant brain context found.';

  return data
    .map((t: any, i: number) =>
      `[${i + 1}] (${(t.similarity * 100).toFixed(0)}% match, ` +
      `${new Date(t.created_at).toLocaleDateString()})\n${t.content}`
    )
    .join('\n\n');
}

// ================================================================
// ACTIVITY: Capture thought to Open Brain
// ================================================================
export async function captureToBrain(content: string): Promise<void> {
  const [embedding, metadata] = await Promise.all([
    getEmbedding(content),
    extractMetadata(content),
  ]);

  const { error } = await supabase().from('thoughts').insert({
    content,
    embedding,
    metadata: { ...metadata, source: 'open-cortex' },
  });

  if (error) {
    console.error('Failed to capture to brain:', error.message);
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
// Helpers (same embedding/metadata as Open Brain server)
// ================================================================
async function getEmbedding(text: string): Promise<number[]> {
  const r = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'openai/text-embedding-3-small',
      input: text,
    }),
  });

  if (!r.ok) {
    const msg = await r.text().catch(() => '');
    throw new Error(`Embedding failed: ${r.status} ${msg}`);
  }

  const d = await r.json() as EmbeddingResponse;
  return d.data[0].embedding;
}

async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  try {
    const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `Extract metadata. Return JSON: "people" (array), "action_items" (array), "dates_mentioned" (array YYYY-MM-DD), "topics" (1-3 tags), "type" (observation|task|idea|reference|person_note). Only extract what's explicitly there.`,
          },
          { role: 'user', content: text },
        ],
      }),
    });
    const d = await r.json() as ChatCompletionResponse;
    return JSON.parse(d.choices[0].message.content);
  } catch {
    return { topics: ['uncategorized'], type: 'observation' };
  }
}
