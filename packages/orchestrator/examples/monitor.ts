/**
 * Example: Long-Running System Monitor
 *
 * Starts a monitor workflow that:
 * - Checks a system/service at regular intervals
 * - Captures each check result to Cortex Memory
 * - Sends alerts when something looks wrong
 * - Runs indefinitely (uses continueAsNew to avoid history bloat)
 *
 * Usage:
 *   npx ts-node examples/monitor.ts
 */

import { startMonitor } from '../src/client';

async function main() {
  console.log('👁️ Starting a system monitor...\n');

  const workflowId = await startMonitor({
    description:
      'Check production API health at https://api.example.com/health. ' +
      'Verify response time is under 500ms, status is 200, and all service dependencies are healthy. ' +
      'If any check fails, provide details about which component is degraded.',
    interval: '30 minutes',
  });

  console.log('\n✅ Monitor is running continuously.');
  console.log('   It will capture findings to Cortex Memory and alert you if something breaks.');
  console.log(`   Stop it:  npx ts-node -e "require('./src/client').cancelTask('${workflowId}')"`);
}

main().catch(console.error);
