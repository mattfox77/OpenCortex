# Open Brain Hivemind: Distributed AI CLI Orchestration with Temporal

## Architecture Overview

Open Brain Hivemind extends the [Open Brain](https://github.com/NateBJones-Projects/OB1) personal knowledge system into a **distributed orchestration platform** where multiple independent AI CLI workers (Claude Code, OpenClaw, or any MCP-capable agent) share a single Open Brain for context, coordinate through Temporal.io's durable execution engine, and operate as a coherent swarm — each worker autonomous, yet collectively intelligent.

**The core insight**: Open Brain gives AI agents *memory*. Temporal gives them *coordination*. Together, they create something neither can do alone — a fleet of AI workers that remember what each other knows and never drop a task, even when individual workers crash, disconnect, or hit rate limits.

```
┌─────────────────────────────────────────────────────────────┐
│                    TEMPORAL SERVICE                          │
│  (Cloud or self-hosted — the orchestration backbone)        │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ Workflow  │  │ Workflow  │  │ Workflow  │  │ Schedule │   │
│  │ "deploy"  │  │ "review"  │  │ "digest"  │  │ (cron)   │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘   │
│       │              │              │              │         │
│  ─────┴──────────────┴──────────────┴──────────────┴──── ←──│─ Task Queues
│       hivemind-tasks    hivemind-code    hivemind-research   │
└───────────┬─────────────────┬─────────────────┬─────────────┘
            │                 │                 │
            ▼                 ▼                 ▼
┌───────────────┐  ┌───────────────┐  ┌───────────────┐
│  WORKER #1    │  │  WORKER #2    │  │  WORKER #3    │
│  (Mac Studio) │  │  (VPS)        │  │  (Laptop)     │
│               │  │               │  │               │
│  ┌─────────┐  │  │  ┌─────────┐  │  │  ┌─────────┐  │
│  │ Claude  │  │  │  │ Claude  │  │  │  │ Claude  │  │
│  │  Code   │  │  │  │  Code   │  │  │  │  Code   │  │
│  └────┬────┘  │  │  └────┬────┘  │  │  └────┬────┘  │
│       │       │  │       │       │  │       │       │
│  ┌────┴────┐  │  │  ┌────┴────┐  │  │  ┌────┴────┐  │
│  │Temporal │  │  │  │Temporal │  │  │  │Temporal │  │
│  │Worker   │  │  │  │Worker   │  │  │  │Worker   │  │
│  │(Node.js)│  │  │  │(Node.js)│  │  │  │(Node.js)│  │
│  └────┬────┘  │  │  └────┬────┘  │  │  └────┬────┘  │
│       │       │  │       │       │  │       │       │
└───────┼───────┘  └───────┼───────┘  └───────┼───────┘
        │                  │                  │
        └──────────────────┼──────────────────┘
                           │
                           ▼
               ┌───────────────────────┐
               │   OPEN BRAIN          │
               │   (Supabase)          │
               │                       │
               │  thoughts + vectors   │
               │  task_ledger          │
               │  worker_registry      │
               │  workflow_context      │
               └───────────────────────┘
```

---

## What This Beats (And Why)

### vs OpenClaw Multi-Agent

OpenClaw's agent loop is powerful for a single machine. But it hits walls:

- **No durable execution** — if an OpenClaw agent crashes mid-task, the task is lost. You restart and hope the LLM picks up where it left off.
- **No true distributed coordination** — Claworc and Mission Control add dashboards, but the underlying work distribution is still "assign and pray." There's no guarantee a task completes exactly once, no automatic retry with state preservation, no cross-machine task handoff.
- **Memory is per-agent** — each OpenClaw instance has its own markdown-file memory. Sharing context means manual file sync or shared filesystems.
- **Non-deterministic orchestration** — OpenClaw's `sessions_spawn` lets the LLM decide workflow flow. That's creative but unreliable for production pipelines.

### vs Ralph Loop / Gas Town / Multiclaude

These are clever patterns (especially Ralph's hard-context-reset loop), but they're fundamentally single-machine, single-session tools. They don't survive restarts. They don't coordinate across workers. They don't have task queues with exactly-once semantics.

### What Hivemind adds

| Capability | OpenClaw | Ralph | **Hivemind** |
|---|---|---|---|
| Survives worker crash | ✗ | ✗ | **✓ (Temporal replay)** |
| Distributed across machines | Dashboard only | ✗ | **✓ (Task Queues)** |
| Shared semantic memory | ✗ | ✗ | **✓ (Open Brain)** |
| Exactly-once task execution | ✗ | ✗ | **✓ (Temporal guarantees)** |
| Deterministic orchestration | ✗ | Partial | **✓ (Workflow code)** |
| Long-running workflows (days/weeks) | ✗ | ✗ | **✓ (Durable timers)** |
| Human-in-the-loop approval gates | Manual | ✗ | **✓ (Signals)** |
| Observable execution history | Logs | Logs | **✓ (Temporal UI)** |

---

## Core Components

### 1. Open Brain (Extended Schema)

The base Open Brain gives you `thoughts` with vector embeddings. Hivemind extends it with three new tables that turn it from a memory system into a coordination layer.

```sql
-- Base: thoughts table (from Open Brain setup guide)
-- Already has: id, content, embedding, metadata, created_at, updated_at

-- NEW: Worker registry — every CLI instance registers itself
CREATE TABLE worker_registry (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  worker_name TEXT NOT NULL,              -- "matt-macstudio", "deploy-vps-1"
  worker_type TEXT NOT NULL DEFAULT 'claude-code',  -- claude-code | openclaw | custom
  task_queues TEXT[] NOT NULL DEFAULT '{}',         -- which Temporal queues this worker polls
  capabilities TEXT[] NOT NULL DEFAULT '{}',        -- tags: "coding", "research", "devops"
  machine_info JSONB DEFAULT '{}',                  -- os, cpu, memory, location
  status TEXT NOT NULL DEFAULT 'offline',           -- online | offline | busy | paused
  last_heartbeat TIMESTAMPTZ DEFAULT now(),
  registered_at TIMESTAMPTZ DEFAULT now(),
  metadata JSONB DEFAULT '{}'
);

-- NEW: Task ledger — every task attempt is recorded for audit
CREATE TABLE task_ledger (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  temporal_workflow_id TEXT NOT NULL,
  temporal_run_id TEXT,
  task_type TEXT NOT NULL,                 -- "code-review", "deploy", "research"
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | running | completed | failed | cancelled
  worker_id UUID REFERENCES worker_registry(id),
  input JSONB NOT NULL DEFAULT '{}',
  output JSONB DEFAULT '{}',
  error TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  metadata JSONB DEFAULT '{}'
);

-- NEW: Workflow context — shared scratchpad for multi-step workflows
CREATE TABLE workflow_context (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  workflow_id TEXT NOT NULL,               -- Temporal workflow ID
  context_key TEXT NOT NULL,               -- namespaced key: "deploy:env-vars", "review:findings"
  context_value JSONB NOT NULL,
  updated_by TEXT,                         -- worker name that last wrote
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(workflow_id, context_key)
);

-- Indexes
CREATE INDEX idx_worker_status ON worker_registry(status);
CREATE INDEX idx_worker_heartbeat ON worker_registry(last_heartbeat);
CREATE INDEX idx_ledger_workflow ON task_ledger(temporal_workflow_id);
CREATE INDEX idx_ledger_status ON task_ledger(status);
CREATE INDEX idx_context_workflow ON workflow_context(workflow_id);

-- RLS
ALTER TABLE worker_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_context ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON worker_registry FOR ALL
  USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access" ON task_ledger FOR ALL
  USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access" ON workflow_context FOR ALL
  USING (auth.role() = 'service_role');
```

### 2. Temporal Workflows (TypeScript)

Workflows define *what* happens. They're deterministic, durable, and survive any failure. The Temporal service replays them from event history if a worker crashes.

```typescript
// src/workflows/hivemind.ts
import {
  defineSignal,
  defineQuery,
  defineUpdate,
  setHandler,
  proxyActivities,
  condition,
  sleep,
  continueAsNew,
  workflowInfo,
} from '@temporalio/workflow';

import type * as activities from '../activities';

// --- Activity proxies (retries, timeouts configured here) ---
const { executeCliCommand, searchBrain, captureToBrain, 
        updateLedger, getWorkflowContext, setWorkflowContext,
        notifyHuman } = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 minutes',
  retry: { maximumAttempts: 3 },
});

const longRunning = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 hours',
  heartbeatTimeout: '30 seconds',
  retry: { maximumAttempts: 2 },
});

// --- Signals (async messages INTO the workflow) ---
export const approveSignal = defineSignal<[{ approver: string; approved: boolean; notes?: string }]>('approve');
export const feedbackSignal = defineSignal<[{ from: string; message: string }]>('feedback');
export const cancelTaskSignal = defineSignal('cancelTask');

// --- Queries (sync reads of workflow state) ---
export const statusQuery = defineQuery<WorkflowStatus>('status');
export const progressQuery = defineQuery<ProgressInfo>('progress');

// --- Updates (sync request-response INTO the workflow) ---
export const adjustPriorityUpdate = defineUpdate<string, [{ priority: number }]>('adjustPriority');

// --- Types ---
interface WorkflowStatus {
  phase: string;
  currentStep: string;
  workerAssigned: string | null;
  startedAt: string;
  approvalPending: boolean;
}

interface ProgressInfo {
  stepsCompleted: number;
  totalSteps: number;
  lastOutput: string;
  brainThoughtsCaptured: number;
}

interface HivemindTaskInput {
  taskDescription: string;
  taskType: 'code' | 'review' | 'research' | 'deploy' | 'custom';
  requiresApproval: boolean;
  priority: number;
  brainSearchContext?: string;  // pre-seed with relevant brain knowledge
  cliCommand?: string;          // explicit command, or let the AI decide
  maxIterations?: number;       // loop limit (Ralph-style)
}

// ================================================================
// MAIN WORKFLOW: Orchestrate a task across distributed CLI workers
// ================================================================

export async function hivemindTask(input: HivemindTaskInput): Promise<string> {
  const info = workflowInfo();
  
  // --- State (survives crashes via Temporal replay) ---
  let phase = 'initializing';
  let currentStep = '';
  let workerAssigned: string | null = null;
  let approvalPending = false;
  let approvalResult: { approved: boolean; notes?: string } | null = null;
  let cancelled = false;
  let priority = input.priority;
  let stepsCompleted = 0;
  let totalSteps = input.maxIterations || 5;
  let lastOutput = '';
  let brainThoughtsCaptured = 0;
  let feedbackMessages: Array<{ from: string; message: string }> = [];

  // --- Register handlers ---
  setHandler(statusQuery, () => ({
    phase,
    currentStep,
    workerAssigned,
    startedAt: new Date().toISOString(),
    approvalPending,
  }));

  setHandler(progressQuery, () => ({
    stepsCompleted,
    totalSteps,
    lastOutput,
    brainThoughtsCaptured,
  }));

  setHandler(approveSignal, (data) => {
    approvalResult = data;
    approvalPending = false;
  });

  setHandler(feedbackSignal, (data) => {
    feedbackMessages.push(data);
  });

  setHandler(cancelTaskSignal, () => {
    cancelled = true;
  });

  setHandler(adjustPriorityUpdate, (data) => {
    priority = data.priority;
    return `Priority updated to ${priority}`;
  });

  // --- PHASE 1: Gather context from Open Brain ---
  phase = 'gathering-context';
  currentStep = 'Searching Open Brain for relevant knowledge';

  await updateLedger({
    workflowId: info.workflowId,
    status: 'running',
    taskType: input.taskType,
    input: input,
  });

  let brainContext = '';
  if (input.brainSearchContext) {
    const searchResults = await searchBrain(input.brainSearchContext);
    brainContext = searchResults;
    await setWorkflowContext(info.workflowId, 'brain:initial-context', {
      query: input.brainSearchContext,
      results: searchResults,
    });
  }

  // --- PHASE 2: Plan (optionally use Claude to plan steps) ---
  phase = 'planning';
  currentStep = 'Building execution plan';

  const planPrompt = [
    `Task: ${input.taskDescription}`,
    `Type: ${input.taskType}`,
    brainContext ? `\nRelevant context from Open Brain:\n${brainContext}` : '',
    feedbackMessages.length > 0
      ? `\nFeedback received:\n${feedbackMessages.map(f => `${f.from}: ${f.message}`).join('\n')}`
      : '',
  ].join('\n');

  const plan = await executeCliCommand({
    prompt: `You are a task planner. Given this task, produce a numbered step-by-step plan. 
Be specific about commands to run, files to check, and decisions to make.
Output ONLY the plan, no preamble.

${planPrompt}`,
    mode: 'plan',
  });

  await setWorkflowContext(info.workflowId, 'plan:current', { plan });
  stepsCompleted = 1;
  lastOutput = plan;

  // --- PHASE 3: Approval gate (if required) ---
  if (input.requiresApproval) {
    phase = 'awaiting-approval';
    approvalPending = true;
    currentStep = 'Waiting for human approval of execution plan';

    await notifyHuman({
      channel: 'slack', // or telegram, email, etc.
      message: `🧠 Hivemind task "${input.taskDescription}" needs approval.\n\nPlan:\n${plan}`,
      workflowId: info.workflowId,
    });

    // Wait up to 24 hours for approval
    const approved = await condition(() => approvalResult !== null, '24 hours');
    
    if (!approved || !approvalResult?.approved) {
      await updateLedger({
        workflowId: info.workflowId,
        status: 'cancelled',
        output: { reason: approvalResult?.notes || 'Timed out waiting for approval' },
      });
      return `Task cancelled: ${approvalResult?.notes || 'approval timeout'}`;
    }
  }

  // --- PHASE 4: Execute (the Ralph-style loop, but durable) ---
  phase = 'executing';
  let iteration = 0;
  let finalResult = '';

  while (iteration < totalSteps && !cancelled) {
    iteration++;
    currentStep = `Execution iteration ${iteration}/${totalSteps}`;

    // Check for mid-execution feedback
    const pendingFeedback = feedbackMessages.splice(0);

    const executionPrompt = [
      `You are executing step ${iteration} of a task plan.`,
      `\nOriginal task: ${input.taskDescription}`,
      `\nPlan:\n${plan}`,
      `\nCurrent iteration: ${iteration}/${totalSteps}`,
      lastOutput ? `\nPrevious output:\n${lastOutput}` : '',
      pendingFeedback.length > 0
        ? `\nNew feedback:\n${pendingFeedback.map(f => `${f.from}: ${f.message}`).join('\n')}`
        : '',
      `\nExecute the next step. If the task is COMPLETE, start your response with "TASK_COMPLETE:".`,
      `If you need to capture something important to remember, start that line with "BRAIN_CAPTURE:".`,
    ].join('\n');

    // This is the actual CLI invocation — the Activity that talks to Claude Code
    const result = await longRunning.executeCliCommand({
      prompt: executionPrompt,
      mode: 'execute',
      cwd: input.cliCommand ? undefined : '/home/claude',
    });

    lastOutput = result;
    stepsCompleted = iteration + 1;

    // Auto-capture important outputs to Open Brain
    const brainCaptures = result
      .split('\n')
      .filter((line: string) => line.startsWith('BRAIN_CAPTURE:'))
      .map((line: string) => line.replace('BRAIN_CAPTURE:', '').trim());

    for (const capture of brainCaptures) {
      await captureToBrain(capture);
      brainThoughtsCaptured++;
    }

    // Store iteration context for other workers to see
    await setWorkflowContext(info.workflowId, `execution:iteration-${iteration}`, {
      output: result,
      timestamp: new Date().toISOString(),
    });

    // Check for completion signal from the AI
    if (result.includes('TASK_COMPLETE:')) {
      finalResult = result.split('TASK_COMPLETE:')[1]?.trim() || result;
      break;
    }

    // Brief pause between iterations (configurable)
    await sleep('5 seconds');
  }

  // --- PHASE 5: Wrap up ---
  phase = 'completing';
  currentStep = 'Finalizing and recording results';

  // Capture final summary to Open Brain
  const summary = `Completed hivemind task: ${input.taskDescription}. ` +
    `Result: ${finalResult || lastOutput}. ` +
    `Iterations: ${iteration}/${totalSteps}. ` +
    `Brain captures: ${brainThoughtsCaptured}.`;
  
  await captureToBrain(summary);

  await updateLedger({
    workflowId: info.workflowId,
    status: cancelled ? 'cancelled' : 'completed',
    output: { result: finalResult || lastOutput, iterations: iteration },
  });

  phase = 'done';
  return finalResult || lastOutput;
}


// ================================================================
// LONG-RUNNING WORKFLOW: Continuous brain-powered monitoring
// ================================================================

export async function hivemindMonitor(config: {
  watchDescription: string;
  checkInterval: string;   // "30 minutes", "1 hour", etc.
  alertChannel: string;
  maxRuns?: number;
}): Promise<void> {
  let runCount = 0;
  const maxRuns = config.maxRuns || 1000;

  while (runCount < maxRuns) {
    runCount++;

    // Search brain for relevant context about what we're monitoring
    const context = await searchBrain(config.watchDescription);

    // Ask CLI to check the thing
    const checkResult = await executeCliCommand({
      prompt: `You are a monitoring agent. Check the following and report status.
Watch target: ${config.watchDescription}
Previous context from brain: ${context}
Report: Is everything normal? If not, what changed?
Start with "ALERT:" if action is needed, "OK:" if all clear.`,
      mode: 'check',
    });

    // Capture check result to brain
    await captureToBrain(
      `Monitor check (${config.watchDescription}): ${checkResult.substring(0, 200)}`
    );

    // Alert if needed
    if (checkResult.startsWith('ALERT:')) {
      await notifyHuman({
        channel: config.alertChannel,
        message: `🚨 Hivemind Monitor Alert\n\n${config.watchDescription}\n\n${checkResult}`,
        workflowId: workflowInfo().workflowId,
      });
    }

    await sleep(config.checkInterval);
  }

  // Continue-as-new to avoid unbounded history growth
  await continueAsNew<typeof hivemindMonitor>(config);
}
```

### 3. Activities (The Bridge to CLI and Brain)

Activities are where the non-deterministic real-world work happens. They can fail, retry, and run on any worker.

```typescript
// src/activities/index.ts
import { Context } from '@temporalio/activity';
import { createClient } from '@supabase/supabase-js';
import { execSync, spawn } from 'child_process';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY!;

// ----------------------------------------------------------------
// ACTIVITY: Execute a CLI command via Claude Code (or any AI CLI)
// ----------------------------------------------------------------
export async function executeCliCommand(params: {
  prompt: string;
  mode: 'plan' | 'execute' | 'check';
  cwd?: string;
}): Promise<string> {
  const ctx = Context.current();
  
  // Heartbeat so Temporal knows we're still alive during long operations
  const heartbeatInterval = setInterval(() => {
    ctx.heartbeat('executing CLI command...');
  }, 10_000);

  try {
    // Use Claude Code in non-interactive mode
    // The --print flag makes it output directly without the TUI
    const result = execSync(
      `claude --print "${params.prompt.replace(/"/g, '\\"')}"`,
      {
        cwd: params.cwd || process.cwd(),
        timeout: 600_000,  // 10 minute timeout
        maxBuffer: 10 * 1024 * 1024,  // 10MB output buffer
        encoding: 'utf-8',
        env: {
          ...process.env,
          // Pass Open Brain MCP connection so Claude Code has brain access
          // This is configured via claude mcp add (see setup)
        },
      }
    );
    return result.trim();
  } finally {
    clearInterval(heartbeatInterval);
  }
}

// ----------------------------------------------------------------
// ACTIVITY: Search Open Brain for semantic context
// ----------------------------------------------------------------
export async function searchBrain(query: string): Promise<string> {
  const embedding = await getEmbedding(query);
  
  const { data, error } = await supabase.rpc('match_thoughts', {
    query_embedding: embedding,
    match_threshold: 0.4,
    match_count: 5,
    filter: {},
  });

  if (error || !data?.length) return 'No relevant brain context found.';

  return data
    .map((t: any, i: number) => 
      `[${i + 1}] (${(t.similarity * 100).toFixed(0)}% match, ${new Date(t.created_at).toLocaleDateString()})\n${t.content}`
    )
    .join('\n\n');
}

// ----------------------------------------------------------------
// ACTIVITY: Capture thought to Open Brain
// ----------------------------------------------------------------
export async function captureToBrain(content: string): Promise<void> {
  const [embedding, metadata] = await Promise.all([
    getEmbedding(content),
    extractMetadata(content),
  ]);

  await supabase.from('thoughts').insert({
    content,
    embedding,
    metadata: { ...metadata, source: 'hivemind-worker' },
  });
}

// ----------------------------------------------------------------
// ACTIVITY: Update task ledger
// ----------------------------------------------------------------
export async function updateLedger(params: {
  workflowId: string;
  status: string;
  taskType?: string;
  input?: any;
  output?: any;
  workerId?: string;
}): Promise<void> {
  const existing = await supabase
    .from('task_ledger')
    .select('id')
    .eq('temporal_workflow_id', params.workflowId)
    .single();

  if (existing.data) {
    await supabase
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
    await supabase.from('task_ledger').insert({
      temporal_workflow_id: params.workflowId,
      task_type: params.taskType || 'custom',
      status: params.status,
      input: params.input || {},
      worker_id: params.workerId,
      started_at: new Date().toISOString(),
    });
  }
}

// ----------------------------------------------------------------
// ACTIVITY: Get/Set shared workflow context
// ----------------------------------------------------------------
export async function getWorkflowContext(
  workflowId: string,
  key: string
): Promise<any> {
  const { data } = await supabase
    .from('workflow_context')
    .select('context_value')
    .eq('workflow_id', workflowId)
    .eq('context_key', key)
    .single();
  return data?.context_value;
}

export async function setWorkflowContext(
  workflowId: string,
  key: string,
  value: any
): Promise<void> {
  await supabase.from('workflow_context').upsert(
    {
      workflow_id: workflowId,
      context_key: key,
      context_value: value,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'workflow_id,context_key' }
  );
}

// ----------------------------------------------------------------
// ACTIVITY: Notify a human (Slack, Telegram, email, etc.)
// ----------------------------------------------------------------
export async function notifyHuman(params: {
  channel: string;
  message: string;
  workflowId: string;
}): Promise<void> {
  // Implementation depends on your notification setup
  // Could use Slack webhook, Telegram bot, SendGrid, etc.
  console.log(`[NOTIFY:${params.channel}] ${params.message}`);
  
  // Example: Slack webhook
  if (process.env.SLACK_WEBHOOK_URL) {
    await fetch(process.env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: params.message,
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: params.message },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: '✅ Approve' },
                action_id: `approve_${params.workflowId}`,
              },
              {
                type: 'button',
                text: { type: 'plain_text', text: '❌ Reject' },
                action_id: `reject_${params.workflowId}`,
                style: 'danger',
              },
            ],
          },
        ],
      }),
    });
  }
}

// ----------------------------------------------------------------
// Helpers (same as Open Brain server, shared here)
// ----------------------------------------------------------------
async function getEmbedding(text: string): Promise<number[]> {
  const r = await fetch('https://openrouter.ai/api/v1/embeddings', {
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
  const d = await r.json();
  return d.data[0].embedding;
}

async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
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
          content: `Extract metadata. Return JSON: "people" (array), "action_items" (array), "dates_mentioned" (array YYYY-MM-DD), "topics" (1-3 tags), "type" (observation|task|idea|reference|person_note).`,
        },
        { role: 'user', content: text },
      ],
    }),
  });
  const d = await r.json();
  try { return JSON.parse(d.choices[0].message.content); }
  catch { return { topics: ['uncategorized'], type: 'observation' }; }
}
```

### 4. Worker Process (Runs on Each Machine)

Each machine runs a Temporal Worker that polls for tasks and executes them locally using its installed AI CLI.

```typescript
// src/worker.ts
import { Worker, NativeConnection } from '@temporalio/worker';
import * as activities from './activities';
import { createClient } from '@supabase/supabase-js';
import os from 'os';

const WORKER_NAME = process.env.WORKER_NAME || `${os.hostname()}-${process.pid}`;
const TASK_QUEUES = (process.env.TASK_QUEUES || 'hivemind-tasks').split(',');
const CAPABILITIES = (process.env.CAPABILITIES || 'coding,research').split(',');

async function run() {
  // Register this worker in Open Brain
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: workerRecord } = await supabase
    .from('worker_registry')
    .upsert(
      {
        worker_name: WORKER_NAME,
        worker_type: process.env.WORKER_TYPE || 'claude-code',
        task_queues: TASK_QUEUES,
        capabilities: CAPABILITIES,
        machine_info: {
          hostname: os.hostname(),
          platform: os.platform(),
          arch: os.arch(),
          cpus: os.cpus().length,
          memory_gb: Math.round(os.totalmem() / 1e9),
        },
        status: 'online',
        last_heartbeat: new Date().toISOString(),
      },
      { onConflict: 'worker_name' }
    )
    .select()
    .single();

  console.log(`🧠 Hivemind Worker "${WORKER_NAME}" registered`);
  console.log(`   Task Queues: ${TASK_QUEUES.join(', ')}`);
  console.log(`   Capabilities: ${CAPABILITIES.join(', ')}`);

  // Heartbeat loop — update status in Open Brain
  const heartbeatInterval = setInterval(async () => {
    await supabase
      .from('worker_registry')
      .update({ last_heartbeat: new Date().toISOString(), status: 'online' })
      .eq('worker_name', WORKER_NAME);
  }, 30_000);

  // Connect to Temporal
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS || 'localhost:7233',
    // For Temporal Cloud:
    // tls: {
    //   clientCertPair: {
    //     crt: fs.readFileSync(process.env.TEMPORAL_TLS_CERT!),
    //     key: fs.readFileSync(process.env.TEMPORAL_TLS_KEY!),
    //   },
    // },
  });

  // Create workers for each task queue
  const workers = await Promise.all(
    TASK_QUEUES.map((queue) =>
      Worker.create({
        connection,
        namespace: process.env.TEMPORAL_NAMESPACE || 'default',
        taskQueue: queue.trim(),
        workflowsPath: require.resolve('./workflows/hivemind'),
        activities,
      })
    )
  );

  console.log(`🚀 Workers started, polling ${TASK_QUEUES.length} queue(s)`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n🛑 Shutting down...');
    clearInterval(heartbeatInterval);
    await supabase
      .from('worker_registry')
      .update({ status: 'offline' })
      .eq('worker_name', WORKER_NAME);
    for (const w of workers) w.shutdown();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Run all workers (blocks until shutdown)
  await Promise.all(workers.map((w) => w.run()));
}

run().catch((err) => {
  console.error('Worker failed:', err);
  process.exit(1);
});
```

### 5. Client (Start Workflows, Send Signals)

The client is how you interact with the system — start tasks, check status, send approvals.

```typescript
// src/client.ts
import { Connection, Client } from '@temporalio/client';
import { hivemindTask, hivemindMonitor, approveSignal, 
         feedbackSignal, statusQuery, progressQuery } from './workflows/hivemind';

async function getClient(): Promise<Client> {
  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS || 'localhost:7233',
  });
  return new Client({ connection });
}

// --- Start a task ---
export async function startTask(params: {
  description: string;
  type: 'code' | 'review' | 'research' | 'deploy' | 'custom';
  approval?: boolean;
  brainContext?: string;
  queue?: string;
}) {
  const client = await getClient();
  const handle = await client.workflow.start(hivemindTask, {
    taskQueue: params.queue || 'hivemind-tasks',
    workflowId: `hivemind-${params.type}-${Date.now()}`,
    args: [{
      taskDescription: params.description,
      taskType: params.type,
      requiresApproval: params.approval ?? false,
      priority: 5,
      brainSearchContext: params.brainContext,
      maxIterations: 10,
    }],
  });
  
  console.log(`Started workflow: ${handle.workflowId}`);
  return handle;
}

// --- Check status ---
export async function getStatus(workflowId: string) {
  const client = await getClient();
  const handle = client.workflow.getHandle(workflowId);
  return await handle.query(statusQuery);
}

// --- Send approval ---
export async function approve(workflowId: string, approved: boolean, notes?: string) {
  const client = await getClient();
  const handle = client.workflow.getHandle(workflowId);
  await handle.signal(approveSignal, { 
    approver: 'matt', 
    approved, 
    notes 
  });
}

// --- Send feedback mid-execution ---
export async function sendFeedback(workflowId: string, message: string) {
  const client = await getClient();
  const handle = client.workflow.getHandle(workflowId);
  await handle.signal(feedbackSignal, { 
    from: 'matt', 
    message 
  });
}

// --- Start a monitor ---
export async function startMonitor(params: {
  description: string;
  interval: string;
  alertChannel: string;
}) {
  const client = await getClient();
  return await client.workflow.start(hivemindMonitor, {
    taskQueue: 'hivemind-tasks',
    workflowId: `monitor-${Date.now()}`,
    args: [{
      watchDescription: params.description,
      checkInterval: params.interval,
      alertChannel: params.alertChannel,
    }],
  });
}
```

---

## Extended MCP Server (Open Brain + Hivemind Tools)

The original Open Brain MCP server gets new tools so any connected AI can interact with the Hivemind directly.

```typescript
// Additional MCP tools to add to the Open Brain Edge Function

// Tool: Start a Hivemind task
server.registerTool(
  'hivemind_start_task',
  {
    title: 'Start Hivemind Task',
    description: 'Start a distributed task that will be picked up by any available worker.',
    inputSchema: {
      description: z.string().describe('What the task should accomplish'),
      type: z.enum(['code', 'review', 'research', 'deploy', 'custom']).default('custom'),
      requiresApproval: z.boolean().default(false),
      brainContext: z.string().optional().describe('Search query to pre-load brain context'),
      queue: z.string().optional().default('hivemind-tasks'),
    },
  },
  async ({ description, type, requiresApproval, brainContext, queue }) => {
    // Call the Temporal client API to start the workflow
    // (In practice, this hits a small API server that wraps the Temporal client)
    const response = await fetch(`${HIVEMIND_API_URL}/tasks`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${HIVEMIND_API_KEY}`,
      },
      body: JSON.stringify({ description, type, requiresApproval, brainContext, queue }),
    });
    const result = await response.json();
    return {
      content: [{ type: 'text', text: `Task started: ${result.workflowId}` }],
    };
  }
);

// Tool: Check worker fleet status
server.registerTool(
  'hivemind_fleet_status',
  {
    title: 'Hivemind Fleet Status',
    description: 'See which workers are online, what they can do, and what they are doing.',
    inputSchema: {},
  },
  async () => {
    const { data: workers } = await supabase
      .from('worker_registry')
      .select('*')
      .order('last_heartbeat', { ascending: false });

    const { data: activeTasks } = await supabase
      .from('task_ledger')
      .select('*')
      .eq('status', 'running');

    const lines = [
      `Workers: ${workers?.length || 0} registered`,
      '',
      ...(workers || []).map(w => {
        const stale = Date.now() - new Date(w.last_heartbeat).getTime() > 60_000;
        return `  ${stale ? '🔴' : '🟢'} ${w.worker_name} (${w.worker_type})` +
          `\n    Queues: ${w.task_queues.join(', ')}` +
          `\n    Capabilities: ${w.capabilities.join(', ')}` +
          `\n    Last seen: ${new Date(w.last_heartbeat).toLocaleString()}`;
      }),
      '',
      `Active tasks: ${activeTasks?.length || 0}`,
      ...(activeTasks || []).map(t =>
        `  ⚡ ${t.temporal_workflow_id} (${t.task_type}) — ${t.status}`
      ),
    ];

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

// Tool: Send approval/feedback to a running task
server.registerTool(
  'hivemind_signal',
  {
    title: 'Signal Hivemind Task',
    description: 'Send approval, feedback, or cancellation to a running Hivemind task.',
    inputSchema: {
      workflowId: z.string().describe('The workflow ID to signal'),
      action: z.enum(['approve', 'reject', 'feedback', 'cancel']),
      message: z.string().optional().describe('Feedback or rejection reason'),
    },
  },
  async ({ workflowId, action, message }) => {
    const response = await fetch(`${HIVEMIND_API_URL}/tasks/${workflowId}/signal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${HIVEMIND_API_KEY}`,
      },
      body: JSON.stringify({ action, message }),
    });
    const result = await response.json();
    return {
      content: [{ type: 'text', text: `Signal sent: ${action} → ${workflowId}` }],
    };
  }
);
```

---

## Setup Guide

### Prerequisites

- Open Brain set up and working (follow the [main guide](https://promptkit.natebjones.com/20260224_uq1_guide_main))
- Node.js 20+ installed
- Claude Code CLI installed (`npm install -g @anthropic-ai/claude-code`)
- Docker (for local Temporal dev server)

### Step 1: Start Temporal Dev Server

```bash
# Option A: Docker (recommended for dev)
temporal server start-dev --ui-port 8233

# Option B: Temporal Cloud (for production)
# Sign up at temporal.io/cloud and get your namespace + certs
```

Open http://localhost:8233 to see the Temporal UI.

### Step 2: Initialize the Project

```bash
mkdir hivemind && cd hivemind
npm init -y
npm install @temporalio/client @temporalio/worker @temporalio/workflow @temporalio/activity
npm install @supabase/supabase-js
npm install -D typescript @types/node ts-node
npx tsc --init
```

### Step 3: Extend Open Brain Schema

Run the SQL from section 1 above in your Supabase SQL Editor.

### Step 4: Configure Environment

```bash
# .env
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
OPENROUTER_API_KEY=your-openrouter-key
TEMPORAL_ADDRESS=localhost:7233
WORKER_NAME=matt-macstudio
TASK_QUEUES=hivemind-tasks,hivemind-code
CAPABILITIES=coding,devops,research
SLACK_WEBHOOK_URL=https://hooks.slack.com/...  # optional
```

### Step 5: Start a Worker

```bash
npx ts-node src/worker.ts
```

You should see:
```
🧠 Hivemind Worker "matt-macstudio" registered
   Task Queues: hivemind-tasks, hivemind-code
   Capabilities: coding, devops, research
🚀 Workers started, polling 2 queue(s)
```

### Step 6: Start Another Worker (Different Machine)

On your VPS, laptop, or anywhere else:
```bash
WORKER_NAME=deploy-vps-1 \
TASK_QUEUES=hivemind-tasks,hivemind-deploy \
CAPABILITIES=deploy,devops \
npx ts-node src/worker.ts
```

Both workers now poll the same Temporal service. Tasks land on whichever worker picks them up first.

### Step 7: Fire a Task

```bash
npx ts-node -e "
const { startTask } = require('./src/client');
startTask({
  description: 'Review the authentication module for security vulnerabilities',
  type: 'review',
  approval: true,
  brainContext: 'authentication security',
  queue: 'hivemind-code',
}).then(h => console.log('Started:', h.workflowId));
"
```

### Step 8: Connect to Claude Code via MCP

Add the Hivemind MCP tools to your Claude Code:
```bash
claude mcp add --transport http open-brain-hivemind \
  https://YOUR_PROJECT_REF.supabase.co/functions/v1/open-brain-mcp \
  --header "x-brain-key: your-access-key"
```

Now from any Claude Code session, you can say:
> "Start a hivemind task to refactor the database module, search my brain for recent architecture decisions first"

And it will orchestrate across your fleet.

---

## Key Patterns

### Pattern 1: The Durable Ralph Loop

Ralph's genius is the hard context reset between iterations. Hivemind makes it crash-proof:

```
Iteration 1 → Claude Code executes → output captured to Brain + Temporal
    ↓ (worker crashes)
Temporal replays → picks up at iteration 2 → different worker continues
    ↓
Iteration 2 → new worker has full context from Brain + workflow_context
```

### Pattern 2: Specialist Workers

Route tasks to the right machine:
```
hivemind-code queue  → polled by Mac Studio (fast CPU, lots of RAM)
hivemind-deploy queue → polled by VPS (production network access)
hivemind-research queue → polled by any worker (low resource needs)
```

### Pattern 3: Human-in-the-Loop

```
Workflow starts → AI creates plan → Signal pauses for approval
    ↓
You review in Slack/Telegram → click Approve
    ↓
Temporal delivers Signal → workflow resumes → AI executes plan
```

### Pattern 4: Brain-Powered Context Sharing

```
Worker #1 discovers something → captures to Brain
Worker #2 starts related task → searches Brain → finds Worker #1's discovery
```

No shared filesystem needed. No file sync. The Brain IS the shared memory.

---

## What's Next

- **Scheduled workflows** — Use Temporal Schedules for recurring tasks (daily standup prep, weekly reviews, nightly deploys)
- **Child workflows** — Break complex tasks into sub-workflows that can run in parallel across workers
- **Nexus endpoints** — Connect multiple Temporal namespaces for team-level orchestration
- **Dashboard** — Build a React dashboard that reads worker_registry + task_ledger + Temporal API
- **Voice interface** — Pipe Whisper transcriptions into workflow Signals for hands-free control
