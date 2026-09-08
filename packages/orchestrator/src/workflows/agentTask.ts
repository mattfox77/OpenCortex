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

export type AgentTaskState =
  | 'active'
  | 'blocked'
  | 'review'
  | 'completed'
  | 'archived';

export interface AgentTaskWorkflowInput {
  tenantId: string;
  taskId: string;
  ownerId: string;
  title: string;
  project?: string;
  traceContext?: TraceContext;
}

export interface AgentTaskCommand {
  commandId: string;
  type:
    | 'register_workbench'
    | 'mark_blocked'
    | 'request_review'
    | 'complete'
    | 'archive';
  issuedBy: string;
  workbenchId?: string;
  reason?: string;
  payload?: Record<string, unknown>;
}

export interface AgentTaskCommandResult {
  commandId: string;
  accepted: boolean;
  duplicate: boolean;
  taskState: AgentTaskState;
  reason?: string;
}

export interface AgentTaskStatus {
  workflowId: string;
  runId: string;
  tenantId: string;
  taskId: string;
  ownerId: string;
  title: string;
  state: AgentTaskState;
  workbenchIds: string[];
  commandCount: number;
  lastCommandId?: string;
}

export const agentTaskStatusQuery = defineQuery<AgentTaskStatus>('status');
export const agentTaskCommandLogQuery =
  defineQuery<AgentTaskCommandResult[]>('commandLog');
export const externalWorkbenchSignal =
  defineSignal<[{ workbenchId: string }]>('externalWorkbench');
export const commandAgentTaskUpdate =
  defineUpdate<AgentTaskCommandResult, [AgentTaskCommand]>('command');

export async function agentTaskWorkflow(
  input: AgentTaskWorkflowInput,
): Promise<AgentTaskStatus> {
  const info = workflowInfo();
  const workflowId = info.workflowId;
  const runId = info.runId;
  let state: AgentTaskState = 'active';
  const workbenchIds: string[] = [];
  const commandResults = new Map<string, AgentTaskCommandResult>();
  const commandLog: AgentTaskCommandResult[] = [];

  const status = (): AgentTaskStatus => ({
    workflowId,
    runId,
    tenantId: input.tenantId,
    taskId: input.taskId,
    ownerId: input.ownerId,
    title: input.title,
    state,
    workbenchIds,
    commandCount: commandLog.length,
    lastCommandId: commandLog.at(-1)?.commandId,
  });

  setHandler(agentTaskStatusQuery, status);
  setHandler(agentTaskCommandLogQuery, () => commandLog);
  setHandler(externalWorkbenchSignal, data => {
    addWorkbench(workbenchIds, data.workbenchId);
  });
  setHandler(commandAgentTaskUpdate, async command => {
    const previous = commandResults.get(command.commandId);
    if (previous) {
      return { ...previous, duplicate: true };
    }
    const result = acceptTaskCommand(command, state);
    commandResults.set(command.commandId, result);
    commandLog.push(result);
    if (result.accepted) {
      state = applyTaskCommand(command, state, workbenchIds);
      result.taskState = state;
      await projections.setWorkflowContext(
        workflowId,
        `agent-task:${input.taskId}:command:${command.commandId}`,
        {
          command,
          result,
          status: status(),
        },
      );
    }
    return result;
  });

  await projections.upsertWorkflowProjection({
    workflowId,
    runId,
    workflowType: 'AgentTaskWorkflow',
    status: 'running',
    ownerId: input.ownerId,
    project: input.project,
    sourceSystem: 'opencortex',
    sourceSessionId: input.taskId,
    summary: `Agent task authority ready for ${input.title}`,
    data: {
      tenantId: input.tenantId,
      taskId: input.taskId,
      traceId: input.traceContext?.traceId,
    },
    traceContext: input.traceContext,
  });

  await condition(() => state === 'completed' || state === 'archived');
  const finalStatus = status();
  await projections.upsertWorkflowProjection({
    workflowId,
    runId,
    workflowType: 'AgentTaskWorkflow',
    status: finalStatus.state === 'completed' ? 'completed' : 'cancelled',
    ownerId: input.ownerId,
    project: input.project,
    sourceSystem: 'opencortex',
    sourceSessionId: input.taskId,
    summary: `Agent task ${input.taskId} ${state}`,
    data: {
      status: finalStatus,
      traceId: input.traceContext?.traceId,
    },
    traceContext: input.traceContext,
  });
  return finalStatus;
}

function acceptTaskCommand(
  command: AgentTaskCommand,
  state: AgentTaskState,
): AgentTaskCommandResult {
  if (!command.commandId.trim()) {
    return {
      commandId: command.commandId,
      accepted: false,
      duplicate: false,
      taskState: state,
      reason: 'missing_command_id',
    };
  }
  if (state === 'archived' && command.type !== 'archive') {
    return {
      commandId: command.commandId,
      accepted: false,
      duplicate: false,
      taskState: state,
      reason: 'task_archived',
    };
  }
  if (command.type === 'register_workbench' && !command.workbenchId) {
    return {
      commandId: command.commandId,
      accepted: false,
      duplicate: false,
      taskState: state,
      reason: 'missing_workbench_id',
    };
  }
  return {
    commandId: command.commandId,
    accepted: true,
    duplicate: false,
    taskState: state,
  };
}

function applyTaskCommand(
  command: AgentTaskCommand,
  state: AgentTaskState,
  workbenchIds: string[],
): AgentTaskState {
  switch (command.type) {
    case 'register_workbench':
      addWorkbench(workbenchIds, command.workbenchId!);
      return state;
    case 'mark_blocked':
      return 'blocked';
    case 'request_review':
      return 'review';
    case 'complete':
      return 'completed';
    case 'archive':
      return 'archived';
  }
}

function addWorkbench(workbenchIds: string[], workbenchId: string): void {
  if (!workbenchIds.includes(workbenchId)) {
    workbenchIds.push(workbenchId);
    workbenchIds.sort();
  }
}
