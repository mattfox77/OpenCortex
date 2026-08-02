import {
  condition,
  defineSignal,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import type * as activities from '../activities';
import type { RuntimePairPromptResult } from '../activities';
import type { TraceContext } from '../telemetry';

const runtime = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 3 },
});

const projections = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 3 },
});

export interface PairPromptSignalInput {
  reviewerEmail: string;
  reason?: string;
}

export interface PairPromptResponseSignalInput {
  text: string;
  source?: string;
  messageId?: string;
}

export type PairPromptDecision = 'approve' | 'reject';

export const approvePairPromptSignal = defineSignal<[PairPromptSignalInput]>('approve');
export const rejectPairPromptSignal = defineSignal<[PairPromptSignalInput]>('reject');
export const capturePairPromptResponseSignal =
  defineSignal<[PairPromptResponseSignalInput]>('captureResponse');

export interface PairPromptWorkflowInput {
  sessionId: string;
  draftId: string;
  channelId: string;
  ownerId: string;
  runtimeBaseUrl?: string;
  authorizationHeader?: string;
  traceContext?: TraceContext;
}

export interface PairPromptWorkflowResult {
  workflowId: string;
  runId: string;
  sessionId: string;
  draftId: string;
  channelId: string;
  ownerId: string;
  decision: PairPromptDecision;
  reviewedBy: string;
  result: RuntimePairPromptResult;
  response?: PairPromptResponseSignalInput;
}

interface PendingDecision {
  decision: PairPromptDecision;
  reviewerEmail: string;
  reason?: string;
}

export async function pairPromptWorkflow(
  input: PairPromptWorkflowInput,
): Promise<PairPromptWorkflowResult> {
  const info = workflowInfo();
  const workflowId = info.workflowId;
  const runId = info.runId;
  let pendingDecision: PendingDecision | undefined;
  let capturedResponse: PairPromptResponseSignalInput | undefined;

  const decide = (decision: PairPromptDecision, data: PairPromptSignalInput) => {
    if (!pendingDecision) {
      pendingDecision = {
        decision,
        reviewerEmail: data.reviewerEmail,
        reason: data.reason,
      };
    }
  };

  setHandler(approvePairPromptSignal, data => decide('approve', data));
  setHandler(rejectPairPromptSignal, data => decide('reject', data));
  setHandler(capturePairPromptResponseSignal, data => {
    capturedResponse = data;
  });

  await projections.upsertWorkflowProjection({
    workflowId,
    runId,
    workflowType: 'PairPromptWorkflow',
    status: 'running',
    ownerId: input.ownerId,
    sourceSystem: 'opencortex-runtime',
    sourceSessionId: input.sessionId,
    summary: `Awaiting pair prompt review for ${input.draftId}`,
    data: {
      sessionId: input.sessionId,
      draftId: input.draftId,
      channelId: input.channelId,
      traceId: input.traceContext?.traceId,
    },
    traceContext: input.traceContext,
  });

  try {
    await condition(() => pendingDecision !== undefined);
    const decision = pendingDecision!;
    const result =
      decision.decision === 'approve'
        ? await runtime.approveRuntimePairPrompt({
            sessionId: input.sessionId,
            draftId: input.draftId,
            runtimeBaseUrl: input.runtimeBaseUrl,
            authorizationHeader: input.authorizationHeader,
            workflowId,
            runId,
            traceContext: input.traceContext,
          })
        : await runtime.rejectRuntimePairPrompt({
            sessionId: input.sessionId,
            draftId: input.draftId,
            reason: decision.reason,
            runtimeBaseUrl: input.runtimeBaseUrl,
            authorizationHeader: input.authorizationHeader,
            workflowId,
            runId,
            traceContext: input.traceContext,
          });

    const workflowResult: PairPromptWorkflowResult = {
      workflowId,
      runId,
      sessionId: input.sessionId,
      draftId: input.draftId,
      channelId: input.channelId,
      ownerId: input.ownerId,
      decision: decision.decision,
      reviewedBy: decision.reviewerEmail,
      result,
    };

    if (decision.decision === 'approve' && result.draft.status === 'sent') {
      await projections.upsertWorkflowProjection({
        workflowId,
        runId,
        workflowType: 'PairPromptWorkflow',
        status: 'running',
        ownerId: input.ownerId,
        sourceSystem: 'opencortex-runtime',
        sourceSessionId: input.sessionId,
        summary: `Pair prompt ${input.draftId} delivered; awaiting response capture`,
        data: {
          result: workflowResult,
          traceId: input.traceContext?.traceId,
        },
        traceContext: input.traceContext,
      });
      await condition(() => capturedResponse !== undefined);
      workflowResult.response = capturedResponse;
    }

    await projections.upsertWorkflowProjection({
      workflowId,
      runId,
      workflowType: 'PairPromptWorkflow',
      status: 'completed',
      ownerId: input.ownerId,
      sourceSystem: 'opencortex-runtime',
      sourceSessionId: input.sessionId,
      summary: `Pair prompt ${input.draftId} ${result.draft.status}`,
      data: {
        result: workflowResult,
        traceId: input.traceContext?.traceId,
      },
      traceContext: input.traceContext,
    });

    return workflowResult;
  } catch (error) {
    await projections.upsertWorkflowProjection({
      workflowId,
      runId,
      workflowType: 'PairPromptWorkflow',
      status: 'failed',
      ownerId: input.ownerId,
      sourceSystem: 'opencortex-runtime',
      sourceSessionId: input.sessionId,
      summary: `Pair prompt workflow failed for ${input.draftId}: ${errorMessage(error)}`,
      data: {
        draftId: input.draftId,
        traceId: input.traceContext?.traceId,
      },
      traceContext: input.traceContext,
    });
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
