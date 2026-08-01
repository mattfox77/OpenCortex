#!/usr/bin/env ts-node
/**
 * Start a UserProvisioningWorkflow.
 */

import { startUserProvisioning } from '../src/client';
import { newTraceContext, withTraceSpan } from '../src/telemetry';

async function main() {
  const args = process.argv.slice(2);
  let email = '';
  let linuxUser = '';
  let queue: string | undefined;
  let workspaceRoot: string | undefined;
  let homeDir: string | undefined;
  let provisionScript: string | undefined;
  let groups: string[] | undefined;
  let requiredGroups: string[] | undefined;
  let requiredTools: string[] | undefined;
  let workflowId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--email':
        email = args[++i] ?? '';
        break;
      case '--user':
      case '--linux-user':
        linuxUser = args[++i] ?? '';
        break;
      case '--queue':
        queue = args[++i];
        break;
      case '--workspace-root':
        workspaceRoot = args[++i];
        break;
      case '--home-dir':
        homeDir = args[++i];
        break;
      case '--provision-script':
        provisionScript = args[++i];
        break;
      case '--groups':
        groups = parseList(args[++i]);
        break;
      case '--required-groups':
        requiredGroups = parseList(args[++i]);
        break;
      case '--required-tools':
        requiredTools = parseList(args[++i]);
        break;
      case '--workflow-id':
        workflowId = args[++i];
        break;
      default:
        if (!email) {
          email = args[i] ?? '';
        } else if (!linuxUser) {
          linuxUser = args[i] ?? '';
        }
        break;
    }
  }

  if (!email || !linuxUser) {
    console.log(`
OpenCortex - Provision User

Usage:
  npm run provision-user -- --email user@example.com --user mfox

Options:
  --queue <queue>                    Temporal task queue (default: cortex-tasks)
  --workspace-root <path>            Workspace root override
  --home-dir <path>                  Home directory override for verification
  --provision-script <path>          Provisioner script override
  --groups <a,b>                     Identity groups asserted for the user
  --required-groups <a,b>            Groups required before provisioning
  --required-tools <a,b>             Tools to verify (default: node,npm,git,opencode,cortex)
  --workflow-id <id>                 Deterministic workflow id for idempotent restarts
`);
    process.exit(1);
  }

  const traceContext = newTraceContext();
  const result = await withTraceSpan('opencortex.provisioning.cli_request', traceContext, {
    'identity.email': email,
    'identity.linux_user': linuxUser,
  }, async (requestTraceContext) => {
    const handle = await startUserProvisioning({
      email,
      linuxUser,
      queue,
      workspaceRoot,
      homeDir,
      provisionScript,
      groups,
      requiredGroups,
      requiredTools,
      workflowId,
      traceContext: requestTraceContext ?? traceContext,
    });
    return handle.result();
  });

  console.log(JSON.stringify(result, null, 2));
}

function parseList(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }
  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
