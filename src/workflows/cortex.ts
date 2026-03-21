import {
  defineSignal,
  defineQuery,
  setHandler,
  proxyActivities,
  condition,
  sleep,
  continueAsNew,
  workflowInfo,
} from '@temporalio/workflow';

import type * as activities from '../activities';

// --- Activity proxies ---
const brain = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 3 },
});

const cli = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 minutes',
  heartbeatTimeout: '30 seconds',
  retry: { maximumAttempts: 2 },
});

const infra = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 3 },
});

// --- Signals ---
export const approveSignal = defineSignal<[{ approver: string; approved: boolean; notes?: string }]>('approve');
export const feedbackSignal = defineSignal<[{ from: string; message: string }]>('feedback');
export const cancelSignal = defineSignal('cancel');

// --- Queries ---
export const statusQuery = defineQuery<{
  phase: string;
  currentStep: string;
  approvalPending: boolean;
  stepsCompleted: number;
  totalSteps: number;
  lastOutput: string;
  brainCaptures: number;
}>('status');

// --- Types ---
export interface CortexTaskInput {
  taskDescription: string;
  taskType: 'code' | 'review' | 'research' | 'deploy' | 'custom';
  requiresApproval: boolean;
  priority: number;
  brainSearchContext?: string;
  maxIterations?: number;
}

// ================================================================
// MAIN WORKFLOW: cortexTask
// A durable, crash-proof task loop with brain-powered context.
// ================================================================
export async function cortexTask(input: CortexTaskInput): Promise<string> {
  const info = workflowInfo();

  // --- Durable state (survives crashes via replay) ---
  let phase = 'initializing';
  let currentStep = '';
  let approvalPending = false;
  let approvalResult: { approved: boolean; notes?: string } | null = null;
  let cancelled = false;
  let stepsCompleted = 0;
  const totalSteps = input.maxIterations || 10;
  let lastOutput = '';
  let brainCaptures = 0;
  const feedbackQueue: Array<{ from: string; message: string }> = [];

  // --- Register handlers ---
  setHandler(statusQuery, () => ({
    phase, currentStep, approvalPending,
    stepsCompleted, totalSteps, lastOutput, brainCaptures,
  }));

  setHandler(approveSignal, (data) => {
    approvalResult = data;
    approvalPending = false;
  });

  setHandler(feedbackSignal, (data) => {
    feedbackQueue.push(data);
  });

  setHandler(cancelSignal, () => {
    cancelled = true;
  });

  // --- Record task in ledger ---
  await infra.updateLedger({
    workflowId: info.workflowId,
    status: 'running',
    taskType: input.taskType,
    input,
  });

  // --- PHASE 1: Gather brain context ---
  phase = 'gathering-context';
  currentStep = 'Searching Open Brain for relevant knowledge';

  let brainContext = '';
  if (input.brainSearchContext) {
    brainContext = await brain.searchBrain(input.brainSearchContext);
    await infra.setWorkflowContext(info.workflowId, 'brain:initial', {
      query: input.brainSearchContext,
      results: brainContext,
    });
  }

  // --- PHASE 2: Plan ---
  phase = 'planning';
  currentStep = 'Building execution plan';

  const planPrompt = [
    `Task: ${input.taskDescription}`,
    `Type: ${input.taskType}`,
    brainContext ? `\nRelevant context from Open Brain:\n${brainContext}` : '',
    `\nProduce a numbered step-by-step plan. Be specific about commands, files, and decisions. Output ONLY the plan.`,
  ].join('\n');

  const plan = await cli.executeCliCommand({ prompt: planPrompt });
  await infra.setWorkflowContext(info.workflowId, 'plan:current', { plan });
  stepsCompleted = 1;
  lastOutput = plan;

  // --- PHASE 3: Approval gate ---
  if (input.requiresApproval) {
    phase = 'awaiting-approval';
    approvalPending = true;
    currentStep = 'Waiting for human approval';

    await infra.notifyHuman({
      message: `🧠 Open Cortex task needs approval.\n\n**Task:** ${input.taskDescription}\n\n**Plan:**\n${plan}`,
      workflowId: info.workflowId,
    });

    // Wait up to 24 hours
    const gotApproval = await condition(() => approvalResult !== null, '24 hours');

    if (!gotApproval || !approvalResult?.approved) {
      await infra.updateLedger({
        workflowId: info.workflowId,
        status: 'cancelled',
        output: { reason: approvalResult?.notes || 'Approval timeout' },
      });
      return `Task cancelled: ${approvalResult?.notes || 'approval timeout'}`;
    }
  }

  // --- PHASE 4: Execute (the durable loop) ---
  phase = 'executing';
  let iteration = 0;
  let finalResult = '';

  while (iteration < totalSteps && !cancelled) {
    iteration++;
    currentStep = `Iteration ${iteration}/${totalSteps}`;

    // Collect any mid-execution feedback
    const feedback = feedbackQueue.splice(0);

    const execPrompt = [
      `You are executing step ${iteration} of a task plan.`,
      `\nTask: ${input.taskDescription}`,
      `\nPlan:\n${plan}`,
      `\nIteration: ${iteration}/${totalSteps}`,
      lastOutput ? `\nPrevious output:\n${lastOutput.substring(0, 2000)}` : '',
      feedback.length > 0
        ? `\nFeedback received:\n${feedback.map(f => `${f.from}: ${f.message}`).join('\n')}`
        : '',
      `\nExecute the next step. If COMPLETE, start with "TASK_COMPLETE:".`,
      `To save something important to memory, start that line with "BRAIN_CAPTURE:".`,
    ].join('\n');

    const result = await cli.executeCliCommand({ prompt: execPrompt });
    lastOutput = result;
    stepsCompleted = iteration + 1;

    // Auto-capture to brain
    const captures = result.split('\n')
      .filter((l: string) => l.startsWith('BRAIN_CAPTURE:'))
      .map((l: string) => l.replace('BRAIN_CAPTURE:', '').trim());

    for (const capture of captures) {
      await brain.captureToBrain(capture);
      brainCaptures++;
    }

    // Store iteration context
    await infra.setWorkflowContext(info.workflowId, `exec:iter-${iteration}`, {
      output: result.substring(0, 5000),
      timestamp: new Date().toISOString(),
    });

    // Check for completion
    if (result.includes('TASK_COMPLETE:')) {
      finalResult = result.split('TASK_COMPLETE:')[1]?.trim() || result;
      break;
    }

    await sleep('3 seconds');
  }

  // --- PHASE 5: Wrap up ---
  phase = 'completing';
  currentStep = 'Recording results';

  const summary = `Completed cortex task: ${input.taskDescription}. ` +
    `Result: ${(finalResult || lastOutput).substring(0, 500)}. ` +
    `Iterations: ${iteration}/${totalSteps}. Brain captures: ${brainCaptures}.`;

  await brain.captureToBrain(summary);

  await infra.updateLedger({
    workflowId: info.workflowId,
    status: cancelled ? 'cancelled' : 'completed',
    output: { result: finalResult || lastOutput, iterations: iteration },
  });

  phase = 'done';
  return finalResult || lastOutput;
}

// ================================================================
// MONITOR WORKFLOW: Long-running brain-powered monitoring
// ================================================================
export async function cortexMonitor(config: {
  watchDescription: string;
  checkInterval: string;
  maxRuns?: number;
}): Promise<void> {
  let runCount = 0;
  const maxRuns = config.maxRuns || 500;

  while (runCount < maxRuns) {
    runCount++;

    const context = await brain.searchBrain(config.watchDescription);

    const result = await cli.executeCliCommand({
      prompt: `You are a monitoring agent. Check the following:\n` +
        `Target: ${config.watchDescription}\n` +
        `Previous brain context: ${context}\n` +
        `Report: Is everything normal? Start with "ALERT:" if action needed, "OK:" if clear.`,
    });

    await brain.captureToBrain(
      `Monitor check (${config.watchDescription}): ${result.substring(0, 200)}`
    );

    if (result.startsWith('ALERT:')) {
      await infra.notifyHuman({
        message: `🚨 Open Cortex Monitor Alert\n\n${config.watchDescription}\n\n${result}`,
        workflowId: workflowInfo().workflowId,
      });
    }

    await sleep(config.checkInterval);
  }

  // Continue-as-new to prevent unbounded history
  await continueAsNew<typeof cortexMonitor>(config);
}
