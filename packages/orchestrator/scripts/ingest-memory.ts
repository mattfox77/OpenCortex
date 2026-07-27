#!/usr/bin/env ts-node
/**
 * Start a MemoryIngestWorkflow from a file or stdin.
 */

import { readFileSync } from 'fs';
import { basename } from 'path';
import { startMemoryIngest } from '../src/client';

async function main() {
  const args = process.argv.slice(2);
  let file = '';
  let project: string | undefined;
  let repo: string | undefined;
  let ownerId = process.env.OPENCORTEX_OWNER_ID ?? process.env.OWNER_ID ?? '';
  let sourceSystem = 'opencortex-session';
  let sourceSessionId: string | undefined;
  let scope: 'personal' | 'team' | 'global' = 'personal';
  let toolName: string | undefined;
  let queue: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--file':
        file = args[++i] ?? '';
        break;
      case '--project':
        project = args[++i];
        break;
      case '--repo':
        repo = args[++i];
        break;
      case '--owner':
      case '--owner-id':
        ownerId = args[++i] ?? '';
        break;
      case '--source-system':
        sourceSystem = args[++i] ?? sourceSystem;
        break;
      case '--session-id':
        sourceSessionId = args[++i];
        break;
      case '--scope':
        scope = parseScope(args[++i]);
        break;
      case '--tool':
        toolName = args[++i];
        break;
      case '--queue':
        queue = args[++i];
        break;
      default:
        file = args[i];
        break;
    }
  }

  if (!ownerId) {
    throw new Error('Set OPENCORTEX_OWNER_ID/OWNER_ID or pass --owner');
  }

  const content = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8');
  const artifactName = file ? basename(file) : 'stdin-transcript.txt';
  const handle = await startMemoryIngest({
    content,
    artifactName,
    ownerId,
    sourceSystem,
    sourceSessionId,
    project,
    repo,
    scope,
    toolName,
    sourcePath: file || artifactName,
    queue,
  });
  const result = await handle.result();
  console.log(JSON.stringify(result, null, 2));
}

function parseScope(value: string | undefined): 'personal' | 'team' | 'global' {
  if (value === 'personal' || value === 'team' || value === 'global') {
    return value;
  }
  throw new Error('--scope must be personal, team, or global');
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
