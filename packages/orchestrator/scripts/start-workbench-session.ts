#!/usr/bin/env ts-node
/**
 * Start a WorkbenchSessionWorkflow backed by the runtime session API.
 */

import type { Duration } from '@temporalio/common';
import { startWorkbenchSession } from '../src/client';
import { newTraceContext, withTraceSpan } from '../src/telemetry';

async function main() {
  const args = process.argv.slice(2);
  let ownerId = process.env.OPENCORTEX_OWNER_ID ?? process.env.OWNER_ID ?? '';
  let project: string | undefined;
  let runtimeBaseUrl =
    process.env.OPENCORTEX_RUNTIME_API_BASE_URL ??
    process.env.OPENCORTEX_RUNTIME_BASE_URL;
  let authorizationHeader = process.env.OPENCORTEX_RUNTIME_AUTH_HEADER;
  let monitorInterval: Duration | undefined;
  let maxProbeIterations: number | undefined;
  let queue: string | undefined;
  let workflowId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--owner':
      case '--owner-id':
        ownerId = args[++i] ?? '';
        break;
      case '--project':
        project = args[++i];
        break;
      case '--runtime-base-url':
        runtimeBaseUrl = args[++i];
        break;
      case '--auth-header':
        authorizationHeader = args[++i];
        break;
      case '--monitor-interval':
        monitorInterval = args[++i] as Duration;
        break;
      case '--max-probes':
        maxProbeIterations = Number.parseInt(args[++i] ?? '', 10);
        break;
      case '--queue':
        queue = args[++i];
        break;
      case '--workflow-id':
        workflowId = args[++i];
        break;
      default:
        ownerId = args[i] ?? ownerId;
        break;
    }
  }

  if (!ownerId || !authorizationHeader) {
    console.log(`
OpenCortex - Start Workbench Session

Usage:
  OPENCORTEX_RUNTIME_AUTH_HEADER='Dev user@example.com' npm run workbench-session -- --owner user@example.com

Options:
  --owner <id>                 Owner for workflow projection
  --project <name>             Optional project for workflow projection
  --runtime-base-url <url>     Runtime API base URL (default: http://127.0.0.1:8080/api)
  --auth-header <value>        Runtime Authorization header value
  --monitor-interval <dur>     Temporal duration between probes
  --max-probes <n>             Probe count before completing (default: 0)
  --queue <queue>              Temporal task queue (default: cortex-tasks)
  --workflow-id <id>           Deterministic workflow id
`);
    process.exit(1);
  }

  if (maxProbeIterations !== undefined && (!Number.isInteger(maxProbeIterations) || maxProbeIterations < 0)) {
    throw new Error('--max-probes must be a non-negative integer');
  }

  const traceContext = newTraceContext();
  const result = await withTraceSpan('opencortex.workbench.cli_request', traceContext, {
    'workflow.type': 'WorkbenchSessionWorkflow',
    'workbench.owner_id': ownerId,
    'workbench.project': project,
  }, async (requestTraceContext) => {
    const handle = await startWorkbenchSession({
      ownerId,
      project,
      runtimeBaseUrl,
      authorizationHeader,
      monitorInterval,
      maxProbeIterations,
      queue,
      workflowId,
      traceContext: requestTraceContext ?? traceContext,
    });
    return handle.result();
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
