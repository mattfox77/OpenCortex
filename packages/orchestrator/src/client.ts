import { Connection, Client } from '@temporalio/client';
import type { Duration } from '@temporalio/common';
import {
  cortexTask,
  cortexMonitor,
  memoryIngestWorkflow,
  approveSignal,
  feedbackSignal,
  cancelSignal,
  statusQuery,
} from './workflows';
import type { CortexTaskInput } from './workflows/cortex';
import type { MemoryIngestInput } from './workflows/memoryIngest';
import { newTraceContext, withTraceSpan } from './telemetry';
import * as dotenv from 'dotenv';

dotenv.config();

let _client: Client;

async function getClient(): Promise<Client> {
  if (!_client) {
    const connection = await Connection.connect({
      address: process.env.TEMPORAL_ADDRESS || 'localhost:7233',
    });
    _client = new Client({ connection });
  }
  return _client;
}

// --- Start a task ---
export async function startTask(params: {
  description: string;
  type?: CortexTaskInput['taskType'];
  approval?: boolean;
  brainContext?: string;
  queue?: string;
  maxIterations?: number;
}) {
  const client = await getClient();
  const workflowId = `cortex-${params.type || 'task'}-${Date.now()}`;

  const handle = await client.workflow.start(cortexTask, {
    taskQueue: params.queue || 'cortex-tasks',
    workflowId,
    args: [{
      taskDescription: params.description,
      taskType: params.type || 'custom',
      requiresApproval: params.approval ?? false,
      priority: 5,
      brainSearchContext: params.brainContext,
      maxIterations: params.maxIterations || 10,
    }],
  });

  console.log(`✅ Started workflow: ${workflowId}`);
  console.log(`   View in Temporal UI: http://localhost:8233/namespaces/default/workflows/${workflowId}`);
  return handle;
}

// --- Get workflow status ---
export async function getStatus(workflowId: string) {
  const client = await getClient();
  const handle = client.workflow.getHandle(workflowId);
  return await handle.query(statusQuery);
}

// --- Approve or reject ---
export async function approve(workflowId: string, approved: boolean, notes?: string) {
  const client = await getClient();
  const handle = client.workflow.getHandle(workflowId);
  await handle.signal(approveSignal, {
    approver: process.env.WORKER_NAME || 'human',
    approved,
    notes,
  });
  console.log(`${approved ? '✅ Approved' : '❌ Rejected'}: ${workflowId}`);
}

// --- Send feedback to a running task ---
export async function sendFeedback(workflowId: string, message: string) {
  const client = await getClient();
  const handle = client.workflow.getHandle(workflowId);
  await handle.signal(feedbackSignal, {
    from: process.env.WORKER_NAME || 'human',
    message,
  });
  console.log(`💬 Feedback sent to: ${workflowId}`);
}

// --- Cancel a running task ---
export async function cancelTask(workflowId: string) {
  const client = await getClient();
  const handle = client.workflow.getHandle(workflowId);
  await handle.signal(cancelSignal);
  console.log(`🛑 Cancel signal sent to: ${workflowId}`);
}

// --- Start a long-running monitor ---
export async function startMonitor(params: {
  description: string;
  interval?: Duration;
}) {
  const client = await getClient();
  const workflowId = `cortex-monitor-${Date.now()}`;

  await client.workflow.start(cortexMonitor, {
    taskQueue: 'cortex-tasks',
    workflowId,
    args: [{
      watchDescription: params.description,
      checkInterval: params.interval || '30 minutes',
    }],
  });

  console.log(`👁️ Monitor started: ${workflowId}`);
  console.log(`   Checking: ${params.description}`);
  console.log(`   Interval: ${params.interval || '30 minutes'}`);
  return workflowId;
}

// --- Start a memory ingest workflow ---
export async function startMemoryIngest(
  params: MemoryIngestInput & {
    queue?: string;
    workflowId?: string;
  },
) {
  const client = await getClient();
  const workflowId =
    params.workflowId ??
    `memory-ingest-${params.sourceSystem}-${params.sourceSessionId ?? Date.now()}`;
  const traceContext = params.traceContext ?? newTraceContext();

  const handle = await withTraceSpan('opencortex.memory.start_ingest_workflow', traceContext, {
    'workflow.id': workflowId,
    'workflow.type': 'MemoryIngestWorkflow',
    'memory.owner_id': params.ownerId,
    'memory.source_system': params.sourceSystem,
  }, async (workflowTraceContext) => client.workflow.start(memoryIngestWorkflow, {
      taskQueue: params.queue || 'cortex-tasks',
      workflowId,
      args: [{
        content: params.content,
        artifactName: params.artifactName,
        ownerId: params.ownerId,
        sourceSystem: params.sourceSystem,
        sourceSessionId: params.sourceSessionId,
        project: params.project,
        repo: params.repo,
        scope: params.scope,
        toolName: params.toolName,
        mimeType: params.mimeType,
        sourcePath: params.sourcePath,
        traceContext: workflowTraceContext ?? traceContext,
      }],
    }));

  console.log(`✅ Started memory ingest workflow: ${workflowId}`);
  console.log(`   Trace: ${traceContext.traceId}`);
  return handle;
}
