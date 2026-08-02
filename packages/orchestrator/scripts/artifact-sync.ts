#!/usr/bin/env ts-node
/**
 * Start an ArtifactSyncWorkflow for a bounded local artifact tree.
 */

import { startArtifactSync } from '../src/client';
import { newTraceContext, withTraceSpan } from '../src/telemetry';

async function main() {
  const args = process.argv.slice(2);
  let rootDir = '';
  let project: string | undefined;
  let repo: string | undefined;
  let ownerId = process.env.OPENCORTEX_OWNER_ID ?? process.env.OWNER_ID ?? '';
  let sourceSystem = 'opencortex-artifact-sync';
  let sourceSessionId: string | undefined;
  let identitySubject =
    process.env.OPENCORTEX_IDENTITY_SUBJECT ??
    process.env.IDENTITY_SUBJECT;
  let scope: 'personal' | 'team' | 'global' = 'personal';
  let toolName: string | undefined;
  let queue: string | undefined;
  let includeExtensions: string[] | undefined;
  let excludeDirs: string[] | undefined;
  let maxFiles: number | undefined;
  let maxBytes: number | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--root':
      case '--root-dir':
        rootDir = args[++i] ?? '';
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
      case '--identity-subject':
        identitySubject = args[++i];
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
      case '--ext':
      case '--extensions':
        includeExtensions = parseList(args[++i]).map(extension =>
          extension.startsWith('.') ? extension : `.${extension}`,
        );
        break;
      case '--exclude-dir':
      case '--exclude-dirs':
        excludeDirs = parseList(args[++i]);
        break;
      case '--max-files':
        maxFiles = parsePositiveInteger('--max-files', args[++i]);
        break;
      case '--max-bytes':
        maxBytes = parsePositiveInteger('--max-bytes', args[++i]);
        break;
      default:
        rootDir = args[i] ?? rootDir;
        break;
    }
  }

  if (!rootDir) {
    throw new Error('Pass --root with the artifact directory to sync');
  }
  if (!ownerId) {
    throw new Error('Set OPENCORTEX_OWNER_ID/OWNER_ID or pass --owner');
  }

  const traceContext = newTraceContext();
  const result = await withTraceSpan('opencortex.artifact_sync.request', traceContext, {
    'artifact_sync.owner_id': ownerId,
    'identity.subject': identitySubject,
    'artifact_sync.source_system': sourceSystem,
    'artifact_sync.source_session_id': sourceSessionId,
    'artifact_sync.root_dir': rootDir,
  }, async (requestTraceContext) => {
    const handle = await startArtifactSync({
      rootDir,
      ownerId,
      sourceSystem,
      sourceSessionId,
      project,
      repo,
      scope,
      toolName,
      identitySubject,
      includeExtensions,
      excludeDirs,
      maxFiles,
      maxBytes,
      queue,
      traceContext: requestTraceContext ?? traceContext,
    });
    return handle.result();
  });
  console.log(JSON.stringify(result, null, 2));
}

function parseScope(value: string | undefined): 'personal' | 'team' | 'global' {
  if (value === 'personal' || value === 'team' || value === 'global') {
    return value;
  }
  throw new Error('--scope must be personal, team, or global');
}

function parseList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function parsePositiveInteger(name: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
