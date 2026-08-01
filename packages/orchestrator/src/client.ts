import { Connection, Client } from '@temporalio/client';
import type { Duration } from '@temporalio/common';
import {
  cortexTask,
  cortexMonitor,
  memoryIngestWorkflow,
  userProvisioningWorkflow,
  activityRollupWorkflow,
  workbenchSessionWorkflow,
  approveSignal,
  feedbackSignal,
  cancelSignal,
  stopSessionSignal,
  archiveSessionSignal,
  attachIssueSignal,
  sendPairPromptSignal,
  statusQuery,
} from './workflows';
import type { CortexTaskInput } from './workflows/cortex';
import type { MemoryIngestInput } from './workflows/memoryIngest';
import type { UserProvisioningInput } from './workflows/userProvisioning';
import type { ActivityRollupInput } from './workflows/activityRollup';
import type { WorkbenchSessionInput } from './workflows/workbenchSession';
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
      identitySubject: params.identitySubject,
      traceContext: workflowTraceContext ?? traceContext,
    }],
  }));

  console.log(`✅ Started memory ingest workflow: ${workflowId}`);
  console.log(`   Trace: ${traceContext.traceId}`);
  return handle;
}

// --- Start a user provisioning workflow ---
export async function startUserProvisioning(
  params: UserProvisioningInput & {
    queue?: string;
    workflowId?: string;
  },
) {
  const client = await getClient();
  const workflowId =
    params.workflowId ??
    `user-provisioning-${params.linuxUser}-${Date.now()}`;
  const traceContext = params.traceContext ?? newTraceContext();

  const handle = await withTraceSpan('opencortex.provisioning.start_workflow', traceContext, {
    'workflow.id': workflowId,
    'workflow.type': 'UserProvisioningWorkflow',
    'identity.email': params.email,
    'identity.linux_user': params.linuxUser,
  }, async (workflowTraceContext) => client.workflow.start(userProvisioningWorkflow, {
    taskQueue: params.queue || 'cortex-tasks',
    workflowId,
    args: [{
      email: params.email,
      linuxUser: params.linuxUser,
      groups: params.groups,
      requiredGroups: params.requiredGroups,
      workspaceRoot: params.workspaceRoot,
      homeDir: params.homeDir,
      provisionScript: params.provisionScript,
      requiredTools: params.requiredTools,
      traceContext: workflowTraceContext ?? traceContext,
    }],
  }));

  console.log(`✅ Started user provisioning workflow: ${workflowId}`);
  console.log(`   Trace: ${traceContext.traceId}`);
  return handle;
}

// --- Start an activity rollup workflow ---
export async function startActivityRollup(
  params: ActivityRollupInput & {
    queue?: string;
    workflowId?: string;
  },
) {
  const client = await getClient();
  const workflowId =
    params.workflowId ??
    `activity-rollup-${params.rangeStart.slice(0, 10)}-${Date.now()}`;

  const handle = await client.workflow.start(activityRollupWorkflow, {
    taskQueue: params.queue || 'cortex-tasks',
    workflowId,
    args: [{
      policy: params.policy,
      rangeStart: params.rangeStart,
      rangeEnd: params.rangeEnd,
      events: params.events,
      ownerId: params.ownerId,
      project: params.project,
      traceContext: params.traceContext,
    }],
  });

  console.log(`✅ Started activity rollup workflow: ${workflowId}`);
  return handle;
}

// --- Start a workbench session workflow ---
export async function startWorkbenchSession(
  params: WorkbenchSessionInput & {
    queue?: string;
    workflowId?: string;
  },
) {
  const client = await getClient();
  const workflowId =
    params.workflowId ??
    `workbench-session-${Date.now()}`;
  const traceContext = params.traceContext ?? newTraceContext();

  const handle = await withTraceSpan('opencortex.workbench.start_session_workflow', traceContext, {
    'workflow.id': workflowId,
    'workflow.type': 'WorkbenchSessionWorkflow',
    'workbench.owner_id': params.ownerId,
  }, async (workflowTraceContext) => client.workflow.start(workbenchSessionWorkflow, {
    taskQueue: params.queue || 'cortex-tasks',
    workflowId,
    args: [{
      ownerId: params.ownerId,
      project: params.project,
      runtimeBaseUrl: params.runtimeBaseUrl,
      authorizationHeader: params.authorizationHeader,
      monitorInterval: params.monitorInterval,
      maxProbeIterations: params.maxProbeIterations,
      traceContext: workflowTraceContext ?? traceContext,
    }],
  }));

  console.log(`✅ Started workbench session workflow: ${workflowId}`);
  console.log(`   Trace: ${traceContext.traceId}`);
  return handle;
}

export async function stopWorkbenchSession(workflowId: string, reason?: string) {
  const client = await getClient();
  const handle = client.workflow.getHandle(workflowId);
  await handle.signal(stopSessionSignal, { reason });
  console.log(`🛑 Stop signal sent to workbench session workflow: ${workflowId}`);
}

export async function archiveWorkbenchSession(workflowId: string, reason?: string) {
  const client = await getClient();
  const handle = client.workflow.getHandle(workflowId);
  await handle.signal(archiveSessionSignal, { reason });
  console.log(`🗄️ Archive signal sent to workbench session workflow: ${workflowId}`);
}

export async function attachWorkbenchIssue(
  workflowId: string,
  params: { issueKey: string; url?: string },
) {
  const client = await getClient();
  const handle = client.workflow.getHandle(workflowId);
  await handle.signal(attachIssueSignal, params);
  console.log(`🔗 Issue signal sent to workbench session workflow: ${workflowId}`);
}

export async function sendWorkbenchPairPrompt(
  workflowId: string,
  params: { prompt: string; threadId?: string },
) {
  const client = await getClient();
  const handle = client.workflow.getHandle(workflowId);
  await handle.signal(sendPairPromptSignal, params);
  console.log(`💬 Pair prompt signal sent to workbench session workflow: ${workflowId}`);
}
