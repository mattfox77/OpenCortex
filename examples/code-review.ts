/**
 * Example: Distributed Code Review
 *
 * Start a code review task that:
 * 1. Searches your Open Brain for architectural context
 * 2. Plans the review approach
 * 3. Waits for your approval
 * 4. Executes the review via Claude Code
 * 5. Captures findings back to your Open Brain
 *
 * Usage:
 *   npx ts-node examples/code-review.ts
 */

import { startTask } from '../src/client';

async function main() {
  console.log('🔍 Starting a code review task...\n');

  const handle = await startTask({
    description:
      'Review the authentication module (src/auth/) for security vulnerabilities. ' +
      'Check for SQL injection, XSS, improper token handling, and missing input validation. ' +
      'Produce a numbered list of findings with severity (critical/high/medium/low) and suggested fixes.',
    type: 'review',
    approval: true, // Will pause for your approval before executing
    brainContext: 'authentication security architecture', // Pre-load relevant brain context
    queue: 'cortex-code',
    maxIterations: 5,
  });

  console.log('\n⏳ Workflow is running. Check the Temporal UI for status.');
  console.log('   To approve: npx ts-node -e "require(\'./src/client\').approve(\'' + handle.workflowId + '\', true)"');
  console.log('   To reject:  npx ts-node -e "require(\'./src/client\').approve(\'' + handle.workflowId + '\', false, \'Needs more scope\')"');

  // Wait for result
  const result = await handle.result();
  console.log('\n📋 Review complete:\n');
  console.log(result);
}

main().catch(console.error);
