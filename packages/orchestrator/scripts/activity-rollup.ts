#!/usr/bin/env ts-node
/**
 * Start an ActivityRollupWorkflow from a JSON event file or stdin.
 */

import { readFileSync } from 'fs';
import { startActivityRollup } from '../src/client';
import type { ActivityRollupEvent } from '../src/workflows/activityRollup';
import { newTraceContext, withTraceSpan } from '../src/telemetry';

async function main() {
  const args = process.argv.slice(2);
  let file = '';
  let rangeStart = '';
  let rangeEnd = '';
  let enabled = process.env.OPENCORTEX_ACTIVITY_LEDGER_ENABLED === 'true';
  let ownerId = process.env.OPENCORTEX_OWNER_ID ?? process.env.OWNER_ID ?? 'system';
  let project: string | undefined;
  let queue: string | undefined;
  let workflowId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--file':
        file = args[++i] ?? '';
        break;
      case '--range-start':
        rangeStart = args[++i] ?? '';
        break;
      case '--range-end':
        rangeEnd = args[++i] ?? '';
        break;
      case '--enabled':
        enabled = true;
        break;
      case '--disabled':
        enabled = false;
        break;
      case '--owner':
      case '--owner-id':
        ownerId = args[++i] ?? ownerId;
        break;
      case '--project':
        project = args[++i];
        break;
      case '--queue':
        queue = args[++i];
        break;
      case '--workflow-id':
        workflowId = args[++i];
        break;
      default:
        file = args[i] ?? '';
        break;
    }
  }

  if (!rangeStart || !rangeEnd) {
    console.log(`
OpenCortex - Activity Rollup

Usage:
  npm run activity-rollup -- --range-start 2026-08-01T00:00:00.000Z --range-end 2026-08-02T00:00:00.000Z --file events.json --enabled

Options:
  --file <path>            JSON array of activity events; omit to read stdin
  --range-start <iso>      Inclusive range start
  --range-end <iso>        Exclusive range end
  --enabled                Run rollup even when OPENCORTEX_ACTIVITY_LEDGER_ENABLED is not true
  --disabled               Start workflow with policy.enabled=false
  --owner <id>             Owner for workflow projection (default: OPENCORTEX_OWNER_ID or system)
  --project <name>         Optional project for workflow projection
  --queue <queue>          Temporal task queue (default: cortex-tasks)
  --workflow-id <id>       Deterministic workflow id for idempotent starts
`);
    process.exit(1);
  }

  const payload = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8');
  const events = parseEvents(payload);
  const traceContext = newTraceContext();
  const result = await withTraceSpan('opencortex.activity.rollup_request', traceContext, {
    'workflow.type': 'ActivityRollupWorkflow',
    'activity.owner_id': ownerId,
    'activity.project': project,
  }, async (requestTraceContext) => {
    const handle = await startActivityRollup({
      policy: { enabled },
      rangeStart,
      rangeEnd,
      events,
      ownerId,
      project,
      queue,
      workflowId,
      traceContext: requestTraceContext ?? traceContext,
    });
    return handle.result();
  });
  console.log(JSON.stringify(result, null, 2));
}

function parseEvents(payload: string): ActivityRollupEvent[] {
  if (!payload.trim()) {
    return [];
  }
  const parsed = JSON.parse(payload);
  if (!Array.isArray(parsed)) {
    throw new Error('activity rollup input must be a JSON array');
  }
  return parsed.map((event, index) => {
    if (!event || typeof event !== 'object') {
      throw new Error(`activity event ${index} must be an object`);
    }
    return event as ActivityRollupEvent;
  });
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
