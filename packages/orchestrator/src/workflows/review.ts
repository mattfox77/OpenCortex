import {
  condition,
  defineSignal,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import type * as activities from '../activities';
import type {
  MemoryEntryReview,
  ReviewMemoryEntryResult,
} from '../activities';
import type { TraceContext } from '../telemetry';

const reviewActivities = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 3 },
});

const projections = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 3 },
});

export interface ReviewSignalInput {
  reviewerEmail: string;
  notes?: string;
}

export type ReviewDecision = 'approve' | 'reject' | 'markNoise' | 'requestChanges';

export const approveReviewSignal = defineSignal<[ReviewSignalInput]>('approve');
export const rejectReviewSignal = defineSignal<[ReviewSignalInput]>('reject');
export const markNoiseReviewSignal = defineSignal<[ReviewSignalInput]>('markNoise');
export const requestChangesReviewSignal = defineSignal<[ReviewSignalInput]>('requestChanges');

export interface ReviewWorkflowInput {
  entryId: string;
  ownerId: string;
  project?: string;
  reviewerEmail?: string;
  traceContext?: TraceContext;
}

export interface ReviewWorkflowResult {
  workflowId: string;
  runId: string;
  entryId: string;
  ownerId: string;
  decision: ReviewDecision;
  review: MemoryEntryReview;
  reviewedBy: string;
  result: ReviewMemoryEntryResult;
}

interface PendingDecision {
  decision: ReviewDecision;
  review: MemoryEntryReview;
  reviewerEmail: string;
  notes?: string;
}

export async function reviewWorkflow(
  input: ReviewWorkflowInput,
): Promise<ReviewWorkflowResult> {
  const info = workflowInfo();
  const workflowId = info.workflowId;
  const runId = info.runId;
  let pendingDecision: PendingDecision | undefined;

  const decide = (
    decision: ReviewDecision,
    review: MemoryEntryReview,
    data: ReviewSignalInput,
  ) => {
    if (!pendingDecision) {
      pendingDecision = {
        decision,
        review,
        reviewerEmail: data.reviewerEmail,
        notes: data.notes,
      };
    }
  };

  setHandler(approveReviewSignal, data => decide('approve', 'approved', data));
  setHandler(rejectReviewSignal, data => decide('reject', 'rejected', data));
  setHandler(markNoiseReviewSignal, data => decide('markNoise', 'noise', data));
  setHandler(requestChangesReviewSignal, data =>
    decide('requestChanges', 'changes_requested', data),
  );

  await projections.upsertWorkflowProjection({
    workflowId,
    runId,
    workflowType: 'ReviewWorkflow',
    status: 'running',
    ownerId: input.ownerId,
    project: input.project,
    entryIds: [input.entryId],
    summary: `Awaiting review for memory entry ${input.entryId}`,
    data: {
      entryId: input.entryId,
      reviewerEmail: input.reviewerEmail,
      traceId: input.traceContext?.traceId,
    },
    traceContext: input.traceContext,
  });

  try {
    await condition(() => pendingDecision !== undefined);
    const resolvedDecision = pendingDecision!;
    const result = await reviewActivities.updateMemoryEntryReview({
      entryId: input.entryId,
      ownerId: input.ownerId,
      review: resolvedDecision.review,
      reviewerEmail: resolvedDecision.reviewerEmail,
      notes: resolvedDecision.notes,
      workflowId,
      runId,
      traceContext: input.traceContext,
    });

    const workflowResult: ReviewWorkflowResult = {
      workflowId,
      runId,
      entryId: input.entryId,
      ownerId: input.ownerId,
      decision: resolvedDecision.decision,
      review: resolvedDecision.review,
      reviewedBy: resolvedDecision.reviewerEmail,
      result,
    };

    await projections.upsertWorkflowProjection({
      workflowId,
      runId,
      workflowType: 'ReviewWorkflow',
      status: 'completed',
      ownerId: input.ownerId,
      project: input.project ?? result.project,
      entryIds: [input.entryId],
      summary: `Reviewed memory entry ${input.entryId}: ${resolvedDecision.review}`,
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
      workflowType: 'ReviewWorkflow',
      status: 'failed',
      ownerId: input.ownerId,
      project: input.project,
      entryIds: [input.entryId],
      summary: `Review failed for memory entry ${input.entryId}: ${errorMessage(error)}`,
      data: {
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
