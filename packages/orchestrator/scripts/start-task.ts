#!/usr/bin/env ts-node
/**
 * Start an Open Cortex task from the command line.
 *
 * Usage:
 *   npm run task -- "Describe what the task should do"
 *   npm run task -- --type code --approval "Review auth module for vulnerabilities"
 *   npm run task -- --queue cortex-deploy --approval "Deploy main to staging"
 */

import { startTask, startMonitor } from '../src/client';
import type { Duration } from '@temporalio/common';

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(`
🧠 Open Cortex — Start a task

Usage:
  npm run task -- "Your task description"

Options:
  --type <code|review|research|deploy|custom>  Task type (default: custom)
  --queue <queue-name>                          Target queue (default: cortex-tasks)
  --approval                                    Require human approval before execution
  --brain <search-query>                        Pre-load brain context
  --iterations <n>                              Max loop iterations (default: 10)
  --monitor                                     Start as long-running monitor
  --interval <duration>                         Monitor check interval (default: 30 minutes)
`);
    process.exit(0);
  }

  // Parse flags
  let type: any = 'custom';
  let queue = 'cortex-tasks';
  let approval = false;
  let brainContext: string | undefined;
  let maxIterations = 10;
  let isMonitor = false;
  let interval: Duration = '30 minutes';
  const descParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--type': type = args[++i]; break;
      case '--queue': queue = args[++i]; break;
      case '--approval': approval = true; break;
      case '--brain': brainContext = args[++i]; break;
      case '--iterations': maxIterations = parseInt(args[++i]); break;
      case '--monitor': isMonitor = true; break;
      case '--interval': interval = args[++i] as Duration; break;
      default: descParts.push(args[i]);
    }
  }

  const description = descParts.join(' ');

  if (!description) {
    console.error('❌ Please provide a task description');
    process.exit(1);
  }

  if (isMonitor) {
    await startMonitor({ description, interval });
  } else {
    const handle = await startTask({
      description,
      type,
      approval,
      brainContext,
      queue,
      maxIterations,
    });

    // Wait for result
    console.log('\n⏳ Waiting for result (Ctrl+C to detach)...\n');
    try {
      const result = await handle.result();
      console.log('📋 Result:\n');
      console.log(result);
    } catch (err: any) {
      console.error('❌ Workflow failed:', err.message);
    }
  }
}

main().catch(err => {
  console.error('❌', err.message);
  process.exit(1);
});
