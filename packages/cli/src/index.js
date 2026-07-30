#!/usr/bin/env node
import {
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

function usage() {
  console.error(`Usage:
  cortex login --issuer URL --runtime-url URL [--client-id opencortex-cli]
  cortex memory capture "text"|-
    [-t title] [-p project] [-r repo] [-s personal|team|global] [-k kind]
    [--source-system name] [--session-id id] [--tool name]
  cortex memory search "query" [-n limit] [-p project] [-r repo] [-s scope] [--include-pending]
  cortex memory recall "query" [-n limit] [-p project] [-r repo] [-s scope] [--include-pending]
  cortex session list
  cortex session archive SESSION_ID`);
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
