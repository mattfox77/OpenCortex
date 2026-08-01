#!/usr/bin/env ts-node
/**
 * Signal a running WorkbenchSessionWorkflow.
 */

import {
  archiveWorkbenchSession,
  attachWorkbenchIssue,
  sendWorkbenchPairPrompt,
  stopWorkbenchSession,
} from '../src/client';

async function main() {
  const args = process.argv.slice(2);
  const workflowId = args.shift() ?? '';
  const command = args.shift() ?? '';
  let reason: string | undefined;
  let issueKey = '';
  let url: string | undefined;
  let prompt = '';
  let threadId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--reason':
        reason = args[++i];
        break;
      case '--issue':
      case '--issue-key':
        issueKey = args[++i] ?? '';
        break;
      case '--url':
        url = args[++i];
        break;
      case '--prompt':
        prompt = args[++i] ?? '';
        break;
      case '--thread':
      case '--thread-id':
        threadId = args[++i];
        break;
      default:
        if (command === 'attach-issue' && !issueKey) {
          issueKey = args[i] ?? '';
        } else if (command === 'send-pair-prompt' && !prompt) {
          prompt = args[i] ?? '';
        }
        break;
    }
  }

  if (!workflowId || !command) {
    usage();
  }

  switch (command) {
    case 'stop':
      await stopWorkbenchSession(workflowId, reason);
      return;
    case 'archive':
      await archiveWorkbenchSession(workflowId, reason);
      return;
    case 'attach-issue':
      if (!issueKey) {
        throw new Error('attach-issue requires --issue <key>');
      }
      await attachWorkbenchIssue(workflowId, { issueKey, url });
      return;
    case 'send-pair-prompt':
      if (!prompt) {
        throw new Error('send-pair-prompt requires --prompt <text>');
      }
      await sendWorkbenchPairPrompt(workflowId, { prompt, threadId });
      return;
    default:
      throw new Error(`unknown workbench session signal: ${command}`);
  }
}

function usage(): never {
  console.log(`
OpenCortex - Signal Workbench Session

Usage:
  npm run workbench-session:signal -- <workflow-id> stop [--reason text]
  npm run workbench-session:signal -- <workflow-id> archive [--reason text]
  npm run workbench-session:signal -- <workflow-id> attach-issue --issue ENG-123 [--url https://...]
  npm run workbench-session:signal -- <workflow-id> send-pair-prompt --prompt "review this"
`);
  process.exit(1);
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
