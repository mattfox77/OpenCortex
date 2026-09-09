import {
  defineSignal,
  ParentClosePolicy,
  proxyActivities,
  setHandler,
  sleep,
  startChild,
  workflowInfo,
} from '@temporalio/workflow';
import type { Duration } from '@temporalio/common';
import type * as activities from '../activities';
import type {
  RuntimeWorkbenchProbeResult,
  RuntimeWorkbenchSession,
} from '../activities';
import type { TraceContext } from '../telemetry';
import {
  agentSessionWorkflow,
  commandAgentSessionSignal,
} from './agentSession';
import {
  agentTaskWorkflow,
  commandAgentTaskSignal,
} from './agentTask';

const runtime = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 3 },
});

const projections = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 3 },
});

export const stopSessionSignal = defineSignal<[{ reason?: string }]>('stopSession');
export const archiveSessionSignal = defineSignal<[{ reason?: string }]>('archiveSession');
export const attachIssueSignal = defineSignal<[{ issueKey: string; url?: string }]>('attachIssue');
export const sendPairPromptSignal = defineSignal<[{ prompt: string; threadId?: string }]>('sendPairPrompt');

export interface WorkbenchSessionInput {
  ownerId: string;
  project?: string;
  runtimeBaseUrl?: string;
  monitorInterval?: Duration;
  maxProbeIterations?: number;
  traceContext?: TraceContext;
}

export interface WorkbenchSessionResult {
  workflowId: string;
  runId: string;
  ownerId: string;
  session: RuntimeWorkbenchSession;
  probes: RuntimeWorkbenchProbeResult[];
  stopped: boolean;
  archived: boolean;
  authority?: WorkbenchSessionAuthorityResult;
}

export interface WorkbenchSessionAuthorityResult {
  taskWorkflowId: string;
  sessionWorkflowId: string;
  taskCommandId: string;
  sessionCommandId: string;
}

export async function workbenchSessionWorkflow(
  input: WorkbenchSessionInput,
): Promise<WorkbenchSessionResult> {
  const info = workflowInfo();
  const workflowId = info.workflowId;
  const runId = info.runId;
  const probes: RuntimeWorkbenchProbeResult[] = [];
  const issueAttachments: Array<{ index: number; issueKey: string; url?: string }> = [];
  const pairPrompts: Array<{ index: number; prompt: string; threadId?: string }> = [];
  let issueAttachmentCount = 0;
  let pairPromptCount = 0;
  let stopRequested: { reason?: string } | undefined;
  let archiveRequested: { reason?: string } | undefined;

  setHandler(stopSessionSignal, data => {
    stopRequested = data ?? {};
  });
  setHandler(archiveSessionSignal, data => {
    archiveRequested = data ?? {};
  });
  setHandler(attachIssueSignal, data => {
    issueAttachmentCount += 1;
    issueAttachments.push({ index: issueAttachmentCount, ...data });
  });
  setHandler(sendPairPromptSignal, data => {
    pairPromptCount += 1;
    pairPrompts.push({ index: pairPromptCount, ...data });
  });

  await projections.upsertWorkflowProjection({
    workflowId,
    runId,
    workflowType: 'WorkbenchSessionWorkflow',
    status: 'running',
    ownerId: input.ownerId,
    project: input.project,
    summary: `Starting Workbench session for ${input.ownerId}`,
    data: {
      traceId: input.traceContext?.traceId,
    },
    traceContext: input.traceContext,
  });

  try {
    const started = await runtime.startRuntimeWorkbenchSession({
      runtimeBaseUrl: input.runtimeBaseUrl,
      workflowId,
      runId,
      traceContext: input.traceContext,
    });
    const session = started.session;
    const authority = await startAuthorityWorkflows({
      workflowId,
      tenantId: session.tenantId,
      taskId: session.taskId,
      workbenchId: session.workbenchId,
      ownerId: input.ownerId,
      providerId: session.providerId,
      project: input.project,
      hostId: session.hostId,
      traceContext: input.traceContext,
    });

    await projections.upsertWorkflowProjection({
      workflowId,
      runId,
      workflowType: 'WorkbenchSessionWorkflow',
      status: 'running',
      ownerId: input.ownerId,
      project: input.project,
      sourceSystem: 'opencortex-runtime',
      sourceSessionId: session.id,
      summary: `Workbench session ${session.id} running for ${input.ownerId}`,
      data: {
        session,
        channel: started.channel,
        authority,
        traceId: input.traceContext?.traceId,
      },
      traceContext: input.traceContext,
    });

    const maxProbeIterations = input.maxProbeIterations ?? 0;
    const monitorInterval = input.monitorInterval ?? '30 seconds';
    for (let iteration = 0; iteration < maxProbeIterations; iteration++) {
      if (stopRequested || archiveRequested) {
        break;
      }
      await flushSignalQueues({
        workflowId,
        sessionId: session.id,
        issueAttachments,
        pairPrompts,
      });
      await sleep(monitorInterval);
      const probe = await runtime.probeRuntimeWorkbenchSession({
        sessionId: session.id,
        runtimeBaseUrl: input.runtimeBaseUrl,
        workflowId,
        runId,
        traceContext: input.traceContext,
      });
      probes.push(probe);
      await projections.setWorkflowContext(workflowId, `workbench:probe-${iteration + 1}`, {
        probe,
      });
      if (!probe.running) {
        throw new Error(`Workbench session ${session.id} is no longer visible in runtime`);
      }
    }

    await flushSignalQueues({
      workflowId,
      sessionId: session.id,
      issueAttachments,
      pairPrompts,
    });

    const shouldArchive = Boolean(stopRequested || archiveRequested);
    if (shouldArchive) {
      await runtime.archiveRuntimeWorkbenchSession({
        sessionId: session.id,
        runtimeBaseUrl: input.runtimeBaseUrl,
        workflowId,
        runId,
        traceContext: input.traceContext,
      });
    }

    const result = {
      workflowId,
      runId,
      ownerId: input.ownerId,
      session,
      probes,
      stopped: Boolean(stopRequested),
      archived: shouldArchive,
      authority,
    };
    await projections.upsertWorkflowProjection({
      workflowId,
      runId,
      workflowType: 'WorkbenchSessionWorkflow',
      status: shouldArchive ? 'cancelled' : 'completed',
      ownerId: input.ownerId,
      project: input.project,
      sourceSystem: 'opencortex-runtime',
      sourceSessionId: session.id,
      summary: shouldArchive
        ? `Workbench session ${session.id} archived`
        : `Workbench session ${session.id} supervision completed`,
      data: {
        result,
        stopReason: stopRequested?.reason,
        archiveReason: archiveRequested?.reason,
        traceId: input.traceContext?.traceId,
      },
      traceContext: input.traceContext,
    });
    return result;
  } catch (error) {
    await projections.upsertWorkflowProjection({
      workflowId,
      runId,
      workflowType: 'WorkbenchSessionWorkflow',
      status: 'failed',
      ownerId: input.ownerId,
      project: input.project,
      summary: `Workbench session workflow failed: ${errorMessage(error)}`,
      data: {
        traceId: input.traceContext?.traceId,
      },
      traceContext: input.traceContext,
    });
    throw error;
  }
}

async function flushSignalQueues(params: {
  workflowId: string;
  sessionId: string;
  issueAttachments: Array<{ index: number; issueKey: string; url?: string }>;
  pairPrompts: Array<{ index: number; prompt: string; threadId?: string }>;
}): Promise<void> {
  while (params.issueAttachments.length > 0) {
    const item = params.issueAttachments.shift()!;
    await projections.setWorkflowContext(
      params.workflowId,
      `workbench:${params.sessionId}:issue:${item.index}`,
      item,
    );
  }
  while (params.pairPrompts.length > 0) {
    const item = params.pairPrompts.shift()!;
    await projections.setWorkflowContext(
      params.workflowId,
      `workbench:${params.sessionId}:pair-prompt:${item.index}`,
      item,
    );
  }
}

async function startAuthorityWorkflows(params: {
  workflowId: string;
  tenantId?: string;
  taskId?: string;
  workbenchId?: string;
  ownerId: string;
  providerId?: string;
  project?: string;
  hostId?: string;
  traceContext?: TraceContext;
}): Promise<WorkbenchSessionAuthorityResult | undefined> {
  if (!params.tenantId || !params.taskId || !params.workbenchId) {
    await projections.setWorkflowContext(
      params.workflowId,
      'workbench:authority:missing-canonical-ids',
      {
        tenantIdPresent: Boolean(params.tenantId),
        taskIdPresent: Boolean(params.taskId),
        workbenchIdPresent: Boolean(params.workbenchId),
      },
    );
    return undefined;
  }

  const taskWorkflowId = `agent-task-${params.taskId}`;
  const sessionWorkflowId = `agent-session-${params.workbenchId}`;
  const taskCommandId = `register-workbench-${params.workbenchId}`;
  const sessionCommandId = `launch-${params.workbenchId}`;

  const taskHandle = await startChild(agentTaskWorkflow, {
    workflowId: taskWorkflowId,
    parentClosePolicy: ParentClosePolicy.ABANDON,
    args: [
      {
        tenantId: params.tenantId,
        taskId: params.taskId,
        ownerId: params.ownerId,
        title: params.taskId,
        project: params.project,
        traceContext: params.traceContext,
      },
    ],
  });
  const sessionHandle = await startChild(agentSessionWorkflow, {
    workflowId: sessionWorkflowId,
    parentClosePolicy: ParentClosePolicy.ABANDON,
    args: [
      {
        tenantId: params.tenantId,
        taskId: params.taskId,
        workbenchId: params.workbenchId,
        ownerId: params.ownerId,
        hostId: params.hostId,
        providerId: params.providerId,
        project: params.project,
        traceContext: params.traceContext,
      },
    ],
  });

  await taskHandle.signal(commandAgentTaskSignal, {
    commandId: taskCommandId,
    type: 'register_workbench',
    issuedBy: params.ownerId,
    workbenchId: params.workbenchId,
  });
  await sessionHandle.signal(commandAgentSessionSignal, {
    commandId: sessionCommandId,
    type: 'launch',
    issuedBy: params.ownerId,
    reason: 'Legacy WorkbenchSessionWorkflow compatibility launch',
  });

  return {
    taskWorkflowId,
    sessionWorkflowId,
    taskCommandId,
    sessionCommandId,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
