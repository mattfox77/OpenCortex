#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import {
  activityReport,
  defaultCredentialsPath,
  ensureInternalToken,
  memoryCapture,
  memorySearch,
  pollDeviceToken,
  readFreshCredentials,
  sessionArchive,
  sessionList,
  startDeviceLogin,
  tokenExpiresAt,
  writeCredentials,
  workflowList,
  workflowShow,
} from './client.js';

async function main(argv = process.argv.slice(2), env = process.env) {
  const [command, subcommand, ...rest] = argv;
  const credentialsPath = defaultCredentialsPath(env);

  if (command === 'login') {
    const options = parseLoginArgs([subcommand, ...rest].filter(Boolean), env);
    const started = await startDeviceLogin(options);
    console.log(`Open ${started.device.verification_uri_complete ?? started.device.verification_uri}`);
    if (started.device.user_code) {
      console.log(`Code: ${started.device.user_code}`);
    }
    const oidc = await pollDeviceToken({
      metadata: started.metadata,
      device: started.device,
      clientId: options.clientId,
    });
    await writeCredentials(credentialsPath, {
      schemaVersion: 1,
      runtimeUrl: options.runtimeUrl,
      issuer: options.issuer,
      clientId: options.clientId,
      updatedAt: new Date().toISOString(),
      oidc: {
        idToken: oidc.id_token,
        accessToken: oidc.access_token,
        refreshToken: oidc.refresh_token,
        expiresIn: oidc.expires_in,
        expiresAt: tokenExpiresAt(oidc.expires_in),
        tokenType: oidc.token_type,
      },
      internalTokens: {},
    });
    console.log(`Saved credentials to ${credentialsPath}`);
    return;
  }

  if (command === 'memory' && subcommand === 'capture') {
    const parsed = parseCaptureArgs(rest);
    if (parsed.readFromStdin) {
      parsed.content = await readStdin();
    }
    if (!parsed.content.trim()) {
      throw new Error('memory capture requires content');
    }
    delete parsed.readFromStdin;
    const { credentials, token } = await ensureInternalToken({
      credentialsPath,
      scopes: ['memory:write'],
      scopeKey: 'memory:write',
    });
    const payload = await memoryCapture({
      runtimeUrl: credentials.runtimeUrl,
      internalToken: token,
      entry: parsed,
    });
    console.log(payload.entry.id);
    return;
  }

  if (command === 'memory' && subcommand === 'sync') {
    const action = rest.shift();
    if (action !== 'run') {
      throw new Error('memory sync requires run');
    }
    const parsed = await parseMemorySyncRunArgs(rest);
    const { credentials, token } = await ensureInternalToken({
      credentialsPath,
      scopes: ['memory:write'],
      scopeKey: 'memory:write',
    });
    const payload = await memoryCapture({
      runtimeUrl: credentials.runtimeUrl,
      internalToken: token,
      entry: parsed,
    });
    console.log(payload.entry.id);
    return;
  }

  if (command === 'memory' && (subcommand === 'search' || subcommand === 'recall')) {
    const parsed = parseMemoryQueryArgs(rest, {
      defaultLimit: subcommand === 'recall' ? 5 : 10,
      commandName: `memory ${subcommand}`,
    });
    const { credentials, token } = await ensureInternalToken({
      credentialsPath,
      scopes: ['memory:read'],
      scopeKey: 'memory:read',
    });
    const payload = await memorySearch({
      runtimeUrl: credentials.runtimeUrl,
      internalToken: token,
      query: parsed.query,
      limit: parsed.limit,
      project: parsed.project,
      scope: parsed.scope,
      repo: parsed.repo,
      includePending: parsed.includePending,
    });
    if (subcommand === 'recall') {
      printRecall(payload.entries ?? []);
    } else {
      for (const entry of payload.entries ?? []) {
        console.log(`${entry.id}\t${entry.title ?? '(untitled)'}`);
      }
    }
    return;
  }

  if (command === 'session' && subcommand === 'list') {
    const credentials = await readFreshCredentials(credentialsPath);
    const payload = await sessionList({
      runtimeUrl: credentials.runtimeUrl,
      idToken: credentials.oidc.idToken,
    });
    for (const session of payload.sessions ?? []) {
      console.log([
        session.id,
        session.role ?? 'unknown',
        session.name ?? '(untitled)',
        session.ownerEmail ?? '',
        session.urlPath ?? '',
      ].join('\t'));
    }
    return;
  }

  if (command === 'session' && subcommand === 'archive') {
    const sessionId = rest[0] ?? '';
    if (!sessionId) {
      throw new Error('session archive requires a session id');
    }
    const credentials = await readFreshCredentials(credentialsPath);
    const payload = await sessionArchive({
      runtimeUrl: credentials.runtimeUrl,
      idToken: credentials.oidc.idToken,
      sessionId,
    });
    console.log(payload.session.id);
    return;
  }

  if (command === 'activity' && subcommand === 'report') {
    const parsed = parseActivityReportArgs(rest);
    const credentials = await readFreshCredentials(credentialsPath);
    const payload = await activityReport({
      runtimeUrl: credentials.runtimeUrl,
      idToken: credentials.oidc.idToken,
      ...parsed,
    });
    printActivityReport(payload.sessions ?? [], parsed);
    return;
  }

  if (command === 'workflow' && subcommand === 'list') {
    const parsed = parseWorkflowListArgs(rest);
    const credentials = await readFreshCredentials(credentialsPath);
    const payload = await workflowList({
      runtimeUrl: credentials.runtimeUrl,
      idToken: credentials.oidc.idToken,
      ...parsed,
    });
    printWorkflowList(payload.workflows ?? []);
    return;
  }

  if (command === 'workflow' && subcommand === 'show') {
    const workflowId = rest[0] ?? '';
    if (!workflowId) {
      throw new Error('workflow show requires a workflow id');
    }
    const credentials = await readFreshCredentials(credentialsPath);
    const payload = await workflowShow({
      runtimeUrl: credentials.runtimeUrl,
      idToken: credentials.oidc.idToken,
      workflowId,
    });
    printWorkflowDetail(payload.workflow);
    return;
  }

  usage();
  process.exitCode = 1;
}

function parseLoginArgs(args, env) {
  const options = {
    issuer: env.OPENCORTEX_OIDC_ISSUER ?? '',
    clientId: env.OPENCORTEX_OIDC_CLI_CLIENT_ID ?? 'opencortex-cli',
    runtimeUrl: env.OPENCORTEX_RUNTIME_URL ?? env.OPENCORTEX_PUBLIC_BASE_URL ?? '',
  };
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (item === '--issuer') {
      options.issuer = args[++index] ?? '';
    } else if (item === '--client-id') {
      options.clientId = args[++index] ?? '';
    } else if (item === '--runtime-url') {
      options.runtimeUrl = args[++index] ?? '';
    } else {
      throw new Error(`unknown login option: ${item}`);
    }
  }
  if (!options.issuer) {
    throw new Error('login requires --issuer or OPENCORTEX_OIDC_ISSUER');
  }
  if (!options.runtimeUrl) {
    throw new Error('login requires --runtime-url or OPENCORTEX_RUNTIME_URL');
  }
  return options;
}

function parseCaptureArgs(args) {
  const entry = {
    content: '',
    scope: 'team',
    kind: 'thought',
  };
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (item === '--title' || item === '-t') {
      entry.title = args[++index];
    } else if (item === '--project' || item === '-p') {
      entry.project = args[++index];
    } else if (item === '--repo' || item === '-r') {
      entry.repo = args[++index];
    } else if (item === '--scope' || item === '-s') {
      entry.scope = args[++index];
    } else if (item === '--kind' || item === '-k') {
      entry.kind = args[++index];
    } else if (item === '--source-system') {
      entry.sourceSystem = args[++index];
    } else if (item === '--session-id') {
      entry.sourceSessionId = args[++index];
    } else if (item === '--tool') {
      entry.toolName = args[++index];
    } else if (item === '-') {
      entry.readFromStdin = true;
    } else if (!entry.content) {
      entry.content = item;
    } else {
      entry.content = `${entry.content} ${item}`;
    }
  }
  return entry;
}

function parseMemoryQueryArgs(args, options) {
  const parsed = { query: '', limit: options.defaultLimit };
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (item === '--limit' || item === '-n') {
      parsed.limit = Number(args[++index] ?? options.defaultLimit);
    } else if (item === '--project' || item === '-p') {
      parsed.project = args[++index];
    } else if (item === '--scope' || item === '-s') {
      parsed.scope = args[++index];
    } else if (item === '--repo' || item === '-r') {
      parsed.repo = args[++index];
    } else if (item === '--include-pending') {
      parsed.includePending = true;
    } else if (!parsed.query) {
      parsed.query = item;
    } else {
      parsed.query = `${parsed.query} ${item}`;
    }
  }
  if (!parsed.query) {
    throw new Error(`${options.commandName} requires a query`);
  }
  return parsed;
}

async function parseMemorySyncRunArgs(args) {
  const parsed = {
    content: '',
    scope: 'personal',
    kind: 'document',
    sourceSystem: '',
  };
  let file = '';
  let readFromStdin = false;
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (item === '--source') {
      parsed.sourceSystem = args[++index] ?? '';
    } else if (item === '--file' || item === '-f') {
      file = args[++index] ?? '';
    } else if (item === '-') {
      readFromStdin = true;
    } else if (item === '--title' || item === '-t') {
      parsed.title = args[++index];
    } else if (item === '--project' || item === '-p') {
      parsed.project = args[++index];
    } else if (item === '--repo' || item === '-r') {
      parsed.repo = args[++index];
    } else if (item === '--scope' || item === '-s') {
      parsed.scope = args[++index];
    } else if (item === '--kind' || item === '-k') {
      parsed.kind = args[++index];
    } else if (item === '--session-id') {
      parsed.sourceSessionId = args[++index];
    } else if (item === '--tool') {
      parsed.toolName = args[++index];
    } else {
      throw new Error(`unknown memory sync run option: ${item}`);
    }
  }
  if (!parsed.sourceSystem) {
    throw new Error('memory sync run requires --source');
  }
  if (file) {
    parsed.content = await readFile(file, 'utf8');
  } else if (readFromStdin) {
    parsed.content = await readStdin();
  } else {
    throw new Error('memory sync run requires --file PATH or - for stdin');
  }
  if (!parsed.title) {
    parsed.title = `${parsed.sourceSystem} sync`;
  }
  if (!parsed.toolName) {
    parsed.toolName = parsed.sourceSystem;
  }
  if (!parsed.content.trim()) {
    throw new Error('memory sync run found no content');
  }
  return parsed;
}

function parseActivityReportArgs(args, now = new Date()) {
  const parsed = {
    includeArchived: true,
  };
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (item === '--range') {
      Object.assign(parsed, activityRange(args[++index] ?? '', now));
    } else if (item === '--created-after') {
      parsed.createdAfter = args[++index];
    } else if (item === '--created-before') {
      parsed.createdBefore = args[++index];
    } else if (item === '--jira-key') {
      parsed.jiraKey = args[++index];
    } else if (item === '--team-id') {
      parsed.teamId = args[++index];
    } else if (item === '--team-name') {
      parsed.teamName = args[++index];
    } else if (item === '--project-key') {
      parsed.projectKey = args[++index];
    } else if (item === '--owner') {
      parsed.ownerEmail = args[++index];
    } else if (item === '--member') {
      parsed.memberEmail = args[++index];
    } else if (item === '--workspace-dir') {
      parsed.workspaceDir = args[++index];
    } else if (item === '--source') {
      parsed.source = args[++index];
    } else if (item === '--confidence') {
      parsed.confidence = args[++index];
    } else if (item === '--include-archived') {
      parsed.includeArchived = true;
    } else if (item === '--exclude-archived') {
      parsed.includeArchived = false;
    } else if (item === '--include-untagged') {
      parsed.includeUntagged = true;
    } else if (item === '--exclude-untagged') {
      parsed.includeUntagged = false;
    } else {
      throw new Error(`unknown activity report option: ${item}`);
    }
  }
  return parsed;
}

function parseWorkflowListArgs(args) {
  const parsed = { limit: 50 };
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (item === '--type') {
      parsed.workflowType = args[++index];
    } else if (item === '--status') {
      parsed.status = args[++index];
    } else if (item === '--project' || item === '-p') {
      parsed.project = args[++index];
    } else if (item === '--source-system') {
      parsed.sourceSystem = args[++index];
    } else if (item === '--session-id') {
      parsed.sourceSessionId = args[++index];
    } else if (item === '--limit' || item === '-n') {
      parsed.limit = Number(args[++index] ?? parsed.limit);
    } else {
      throw new Error(`unknown workflow list option: ${item}`);
    }
  }
  return parsed;
}

function activityRange(range, now) {
  const end = new Date(now);
  if (range === 'today') {
    const start = startOfUtcDay(end);
    return { createdAfter: start.toISOString(), createdBefore: end.toISOString() };
  }
  if (range === 'yesterday') {
    const before = startOfUtcDay(end);
    const after = addUtcDays(before, -1);
    return { createdAfter: after.toISOString(), createdBefore: before.toISOString() };
  }
  if (range === 'last-week') {
    const after = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
    return { createdAfter: after.toISOString(), createdBefore: end.toISOString() };
  }
  if (range === 'last-month') {
    const after = new Date(end);
    after.setUTCMonth(after.getUTCMonth() - 1);
    return { createdAfter: after.toISOString(), createdBefore: end.toISOString() };
  }
  throw new Error('activity report --range must be today, yesterday, last-week, or last-month');
}

function startOfUtcDay(value) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function addUtcDays(value, days) {
  return new Date(value.getTime() + days * 24 * 60 * 60 * 1000);
}

function printRecall(entries) {
  for (const [index, entry] of entries.entries()) {
    const title = entry.title ?? '(untitled)';
    const scope = entry.scope ? ` [${entry.scope}]` : '';
    const score = Number.isFinite(Number(entry.score))
      ? ` score=${Number(entry.score).toFixed(3)}`
      : '';
    console.log(`${index + 1}. ${title}${scope}${score}`);
    if (entry.project || entry.repo) {
      console.log(`   ${[entry.project, entry.repo].filter(Boolean).join(' | ')}`);
    }
    const content = String(entry.content ?? '').replace(/\s+/g, ' ').trim();
    if (content) {
      console.log(`   ${content.slice(0, 320)}${content.length > 320 ? '...' : ''}`);
    }
  }
}

function printActivityReport(sessions, filters) {
  const jiraKeys = new Set();
  const owners = new Map();
  const teams = new Map();
  let linkedSessions = 0;
  for (const session of sessions) {
    if ((session.jiraItems ?? []).length > 0 || (session.jiraLinks ?? []).length > 0) {
      linkedSessions += 1;
    }
    increment(owners, session.ownerEmail ?? 'unknown');
    for (const item of session.jiraItems ?? []) {
      if (item.key) {
        jiraKeys.add(item.key);
      }
    }
    for (const team of session.teams ?? []) {
      increment(teams, team.name ?? team.id ?? 'unknown');
    }
  }

  const range = [filters.createdAfter, filters.createdBefore].filter(Boolean).join('..') || 'all';
  console.log(`Activity report (${range})`);
  console.log(`Sessions: ${sessions.length}`);
  console.log(`Linked sessions: ${linkedSessions}`);
  console.log(`Jira items: ${jiraKeys.size}`);
  printCountGroup('Owners', owners);
  printCountGroup('Teams', teams);
  if (sessions.length > 0) {
    console.log('Sessions:');
    for (const session of sessions) {
      const jira = (session.jiraItems ?? []).map(item => item.key).filter(Boolean).join(',');
      const teamsText = (session.teams ?? [])
        .map(team => team.name ?? team.id)
        .filter(Boolean)
        .join(',');
      console.log([
        session.id,
        session.ownerEmail ?? '',
        session.name ?? '(untitled)',
        jira || '-',
        teamsText || '-',
      ].join('\t'));
    }
  }
}

function printWorkflowList(workflows) {
  for (const workflow of workflows) {
    console.log([
      workflow.workflowId,
      workflow.status ?? '',
      workflow.workflowType ?? '',
      workflow.ownerId ?? '',
      workflow.project ?? '',
      workflow.completedAt ?? workflow.updatedAt ?? '',
      workflow.summary ?? '',
    ].join('\t'));
  }
}

function printWorkflowDetail(workflow) {
  if (!workflow) {
    return;
  }
  console.log(`Workflow: ${workflow.workflowId}`);
  console.log(`Run: ${workflow.runId ?? ''}`);
  console.log(`Type: ${workflow.workflowType ?? ''}`);
  console.log(`Status: ${workflow.status ?? ''}`);
  console.log(`Owner: ${workflow.ownerId ?? ''}`);
  if (workflow.project) console.log(`Project: ${workflow.project}`);
  if (workflow.sourceSystem) console.log(`Source: ${workflow.sourceSystem}`);
  if (workflow.sourceSessionId) console.log(`Session: ${workflow.sourceSessionId}`);
  if (workflow.artifactId) console.log(`Artifact: ${workflow.artifactId}`);
  if ((workflow.entryIds ?? []).length > 0) {
    console.log(`Entries: ${workflow.entryIds.join(',')}`);
  }
  if (workflow.completedAt) console.log(`Completed: ${workflow.completedAt}`);
  if (workflow.updatedAt) console.log(`Updated: ${workflow.updatedAt}`);
  console.log(`Summary: ${workflow.summary ?? ''}`);
  if (workflow.data && Object.keys(workflow.data).length > 0) {
    console.log('Data:');
    console.log(JSON.stringify(workflow.data, null, 2));
  }
}

function printCountGroup(label, counts) {
  if (counts.size === 0) {
    return;
  }
  console.log(`${label}:`);
  for (const [name, count] of [...counts.entries()].sort(countSort)) {
    console.log(`  ${name}\t${count}`);
  }
}

function increment(counts, key) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function countSort(left, right) {
  return right[1] - left[1] || left[0].localeCompare(right[0]);
}

function usage() {
  console.error(`Usage:
  cortex login --issuer URL --runtime-url URL [--client-id opencortex-cli]
  cortex memory capture "text"|-
    [-t title] [-p project] [-r repo] [-s personal|team|global] [-k kind]
    [--source-system name] [--session-id id] [--tool name]
  cortex memory search "query" [-n limit] [-p project] [-r repo] [-s scope] [--include-pending]
  cortex memory recall "query" [-n limit] [-p project] [-r repo] [-s scope] [--include-pending]
  cortex memory sync run --source opencode (--file PATH|-)
    [-t title] [-p project] [-r repo] [-s personal|team|global] [-k kind]
    [--session-id id] [--tool name]
  cortex session list
  cortex session archive SESSION_ID
  cortex workflow list [--type TYPE] [--status running|completed|failed|cancelled]
    [-p project] [--source-system name] [--session-id id] [-n limit]
  cortex workflow show WORKFLOW_ID
  cortex activity report [--range today|yesterday|last-week|last-month]
    [--created-after ISO] [--created-before ISO] [--jira-key KEY]
    [--team-name NAME] [--project-key KEY] [--owner EMAIL] [--member EMAIL]
    [--include-untagged] [--exclude-archived]`);
}

function readStdin(stream = process.stdin) {
  return new Promise((resolve, reject) => {
    let content = '';
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      content += chunk;
    });
    stream.on('end', () => resolve(content));
    stream.on('error', reject);
  });
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
