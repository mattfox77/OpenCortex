import { proxyActivities, workflowInfo } from '@temporalio/workflow';
import type * as activities from '../activities';
import type {
  ProvisioningIdentityResult,
  UserProvisioningRunResult,
  UserProvisioningVerificationResult,
} from '../activities';
import type { TraceContext } from '../telemetry';

const provisioning = proxyActivities<typeof activities>({
  startToCloseTimeout: '3 minutes',
  retry: { maximumAttempts: 3 },
});

const projections = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 3 },
});

export interface UserProvisioningInput {
  email: string;
  linuxUser: string;
  groups?: string[];
  requiredGroups?: string[];
  workspaceRoot?: string;
  homeDir?: string;
  provisionScript?: string;
  requiredTools?: string[];
  traceContext?: TraceContext;
}

export interface UserProvisioningResult {
  workflowId: string;
  runId: string;
  email: string;
  linuxUser: string;
  validated: ProvisioningIdentityResult;
  provisioned: UserProvisioningRunResult;
  verified: UserProvisioningVerificationResult;
}

export async function userProvisioningWorkflow(
  input: UserProvisioningInput,
): Promise<UserProvisioningResult> {
  const info = workflowInfo();
  const workflowId = info.workflowId;
  const runId = info.runId;
  const ownerId = input.email;

  await projections.upsertWorkflowProjection({
    workflowId,
    runId,
    workflowType: 'UserProvisioningWorkflow',
    status: 'running',
    ownerId,
    summary: `Provisioning ${input.linuxUser} for ${input.email}`,
    data: {
      linuxUser: input.linuxUser,
      groups: input.groups ?? [],
      requiredGroups: input.requiredGroups ?? [],
      traceId: input.traceContext?.traceId,
    },
    traceContext: input.traceContext,
  });

  try {
    const validated = await provisioning.validateProvisioningIdentity({
      email: input.email,
      linuxUser: input.linuxUser,
      groups: input.groups,
      requiredGroups: input.requiredGroups,
      workflowId,
      runId,
      traceContext: input.traceContext,
    });
    const provisioned = await provisioning.runUserProvisioningScript({
      linuxUser: input.linuxUser,
      provisionScript: input.provisionScript,
      workspaceRoot: input.workspaceRoot,
      workflowId,
      runId,
      traceContext: input.traceContext,
    });
    const verified = await provisioning.verifyProvisionedUser({
      linuxUser: input.linuxUser,
      workspaceRoot: input.workspaceRoot,
      homeDir: input.homeDir,
      requiredTools: input.requiredTools,
      workflowId,
      runId,
      traceContext: input.traceContext,
    });

    await projections.upsertWorkflowProjection({
      workflowId,
      runId,
      workflowType: 'UserProvisioningWorkflow',
      status: 'completed',
      ownerId,
      summary:
        `Provisioned ${input.linuxUser}: ` +
        `${verified.skillTargets.length} skill target(s), ` +
        `${enabledToolCount(verified.tools)}/${Object.keys(verified.tools).length} required tool(s) present`,
      data: {
        linuxUser: input.linuxUser,
        homeDir: verified.homeDir,
        workspaceDir: verified.workspaceDir,
        skillTargets: verified.skillTargets,
        tools: verified.tools,
        script: provisioned.script,
        traceId: input.traceContext?.traceId,
      },
      traceContext: input.traceContext,
    });

    return {
      workflowId,
      runId,
      email: input.email,
      linuxUser: input.linuxUser,
      validated,
      provisioned,
      verified,
    };
  } catch (error) {
    await projections.upsertWorkflowProjection({
      workflowId,
      runId,
      workflowType: 'UserProvisioningWorkflow',
      status: 'failed',
      ownerId,
      summary: `Provisioning failed for ${input.linuxUser}: ${errorMessage(error)}`,
      data: {
        linuxUser: input.linuxUser,
        traceId: input.traceContext?.traceId,
      },
      traceContext: input.traceContext,
    });
    throw error;
  }
}

function enabledToolCount(tools: Record<string, boolean>): number {
  return Object.values(tools).filter(Boolean).length;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
