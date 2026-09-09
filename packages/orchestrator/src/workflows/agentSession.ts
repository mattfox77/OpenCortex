import {
  condition,
  defineQuery,
  defineSignal,
  defineUpdate,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import type * as activities from '../activities';
import type { TraceContext } from '../telemetry';

const projections = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 3 },
});

export type AgentSessionCommandType =
  | 'launch'
  | 'prompt'
  | 'approval'
  | 'pause'
  | 'resume'
  | 'stop'
  | 'archive';

export type OrchestrationState =
  | 'preflight'
  | 'provisioning'
  | 'worktree_ready'
  | 'context_ready'
  | 'launching'
  | 'running'
  | 'paused'
  | 'stopping'
  | 'archived'
  | 'failed';

export type ProcessState =
  | 'unknown'
  | 'missing'
  | 'starting'
  | 'running'
  | 'exited';

export type AgentState =
  | 'unknown'
  | 'idle'
  | 'working'
  | 'blocked'
  | 'complete'
  | 'error';

export type ReviewState =
  | 'none'
  | 'requested'
  | 'approved'
  | 'rejected'
  | 'changes_requested';

export interface AgentSessionWorkflowInput {
  tenantId: string;
  taskId: string;
  workbenchId: string;
  ownerId: string;
  hostId?: string;
  providerId?: string;
  project?: string;
  traceContext?: TraceContext;
}

export interface AgentSessionCommand {
  commandId: string;
  type: AgentSessionCommandType;
  issuedBy: string;
  reason?: string;
  prompt?: string;
  payload?: Record<string, unknown>;
}

export interface HostReconciliationSignal {
  observedAt: string;
  hostId?: string;
  processState: ProcessState;
  agentState?: AgentState;
  nativeSessionId?: string;
  confidence: 'authoritative' | 'inferred' | 'unknown';
  detail?: Record<string, unknown>;
}

export interface AgentSessionCommandResult {
  commandId: string;
  accepted: boolean;
  duplicate: boolean;
  orchestrationState: OrchestrationState;
  reason?: string;
}

export interface AgentSessionStatus {
  workflowId: string;
  runId: string;
  tenantId: string;
  taskId: string;
  workbenchId: string;
  ownerId: string;
  hostId?: string;
  providerId?: string;
  orchestrationState: OrchestrationState;
  processState: ProcessState;
  agentState: AgentState;
  reviewState: ReviewState;
  archived: boolean;
  commandCount: number;
  lastCommandId?: string;
  lastRecoveryDecision?: string;
  nativeSessionId?: string;
}

export const agentSessionStatusQuery =
  defineQuery<AgentSessionStatus>('status');
export const agentSessionCommandLogQuery =
  defineQuery<AgentSessionCommandResult[]>('commandLog');
export const reconcileHostSignal =
  defineSignal<[HostReconciliationSignal]>('reconcileHost');
export const commandAgentSessionSignal =
  defineSignal<[AgentSessionCommand]>('commandSignal');
export const commandAgentSessionUpdate =
  defineUpdate<AgentSessionCommandResult, [AgentSessionCommand]>('command');

export async function agentSessionWorkflow(
  input: AgentSessionWorkflowInput,
): Promise<AgentSessionStatus> {
  const info = workflowInfo();
  const workflowId = info.workflowId;
  const runId = info.runId;
  let orchestrationState: OrchestrationState = 'preflight';
  let processState: ProcessState = 'unknown';
  let agentState: AgentState = 'unknown';
  let reviewState: ReviewState = 'none';
  let archived = false;
  let lastRecoveryDecision: string | undefined;
  let nativeSessionId: string | undefined;
  const commandResults = new Map<string, AgentSessionCommandResult>();
  const commandLog: AgentSessionCommandResult[] = [];

  const status = (): AgentSessionStatus => ({
    workflowId,
    runId,
    tenantId: input.tenantId,
    taskId: input.taskId,
    workbenchId: input.workbenchId,
    ownerId: input.ownerId,
    hostId: input.hostId,
    providerId: input.providerId,
    orchestrationState,
    processState,
    agentState,
    reviewState,
    archived,
    commandCount: commandLog.length,
    lastCommandId: commandLog.at(-1)?.commandId,
    lastRecoveryDecision,
    nativeSessionId,
  });

  setHandler(agentSessionStatusQuery, status);
  setHandler(agentSessionCommandLogQuery, () => commandLog);
  setHandler(reconcileHostSignal, data => {
    processState = data.processState;
    agentState = data.agentState ?? agentState;
    nativeSessionId = data.nativeSessionId ?? nativeSessionId;
    lastRecoveryDecision = recoveryDecisionFor(data);
  });
  const recordCommand = async (
    command: AgentSessionCommand,
  ): Promise<AgentSessionCommandResult> => {
    const previous = commandResults.get(command.commandId);
    if (previous) {
      return { ...previous, duplicate: true };
    }
    const result = acceptCommand(command, {
      archived,
      orchestrationState,
    });
    commandResults.set(command.commandId, result);
    commandLog.push(result);
    if (result.accepted) {
      ({ orchestrationState, processState, agentState, reviewState, archived } =
        applyCommand(command, {
          orchestrationState,
          processState,
          agentState,
          reviewState,
          archived,
        }));
      result.orchestrationState = orchestrationState;
      await projections.setWorkflowContext(
        workflowId,
        `agent-session:${input.workbenchId}:command:${command.commandId}`,
        {
          command,
          result,
          status: status(),
        },
      );
    }
    return result;
  };
  setHandler(commandAgentSessionSignal, async command => {
    await recordCommand(command);
  });
  setHandler(commandAgentSessionUpdate, recordCommand);

  await projections.upsertWorkflowProjection({
    workflowId,
    runId,
    workflowType: 'AgentSessionWorkflow',
    status: 'running',
    ownerId: input.ownerId,
    project: input.project,
    sourceSystem: 'opencortex',
    sourceSessionId: input.workbenchId,
    summary: `Agent session authority ready for ${input.workbenchId}`,
    data: {
      tenantId: input.tenantId,
      taskId: input.taskId,
      workbenchId: input.workbenchId,
      hostId: input.hostId,
      providerId: input.providerId,
      traceId: input.traceContext?.traceId,
    },
    traceContext: input.traceContext,
  });

  await condition(() => archived);
  await projections.upsertWorkflowProjection({
    workflowId,
    runId,
    workflowType: 'AgentSessionWorkflow',
    status: 'completed',
    ownerId: input.ownerId,
    project: input.project,
    sourceSystem: 'opencortex',
    sourceSessionId: input.workbenchId,
    summary: `Agent session ${input.workbenchId} archived`,
    data: {
      status: status(),
      traceId: input.traceContext?.traceId,
    },
    traceContext: input.traceContext,
  });
  return status();
}

function acceptCommand(
  command: AgentSessionCommand,
  state: {
    archived: boolean;
    orchestrationState: OrchestrationState;
  },
): AgentSessionCommandResult {
  if (!command.commandId.trim()) {
    return {
      commandId: command.commandId,
      accepted: false,
      duplicate: false,
      orchestrationState: state.orchestrationState,
      reason: 'missing_command_id',
    };
  }
  if (state.archived && command.type !== 'archive') {
    return {
      commandId: command.commandId,
      accepted: false,
      duplicate: false,
      orchestrationState: state.orchestrationState,
      reason: 'session_archived',
    };
  }
  return {
    commandId: command.commandId,
    accepted: true,
    duplicate: false,
    orchestrationState: state.orchestrationState,
  };
}

function applyCommand(
  command: AgentSessionCommand,
  state: {
    orchestrationState: OrchestrationState;
    processState: ProcessState;
    agentState: AgentState;
    reviewState: ReviewState;
    archived: boolean;
  },
): {
  orchestrationState: OrchestrationState;
  processState: ProcessState;
  agentState: AgentState;
  reviewState: ReviewState;
  archived: boolean;
} {
  switch (command.type) {
    case 'launch':
      return {
        ...state,
        orchestrationState: 'launching',
        processState: 'starting',
        agentState: 'unknown',
      };
    case 'prompt':
      return {
        ...state,
        orchestrationState: 'running',
        agentState: 'working',
      };
    case 'approval':
      return {
        ...state,
        reviewState: command.payload?.approved === false ? 'rejected' : 'approved',
      };
    case 'pause':
      return { ...state, orchestrationState: 'paused' };
    case 'resume':
      return { ...state, orchestrationState: 'running' };
    case 'stop':
      return { ...state, orchestrationState: 'stopping' };
    case 'archive':
      return {
        ...state,
        orchestrationState: 'archived',
        processState: state.processState === 'running' ? 'unknown' : state.processState,
        archived: true,
      };
  }
}

function recoveryDecisionFor(signal: HostReconciliationSignal): string {
  if (signal.processState === 'running') {
    return 'matched_existing_process';
  }
  if (signal.processState === 'missing') {
    return 'process_missing_no_auto_relaunch';
  }
  if (signal.confidence === 'unknown') {
    return 'ambiguous_liveness_no_auto_relaunch';
  }
  return `observed_${signal.processState}`;
}
