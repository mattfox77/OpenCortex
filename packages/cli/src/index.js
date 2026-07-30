#!/usr/bin/env node
import {
  defaultCredentialsPath,
  ensureInternalToken,
  memoryCapture,
  memorySearch,
  pollDeviceToken,
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

  if (command === 'memory' && subcommand === 'search') {
    const parsed = parseSearchArgs(rest);
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
    });
    for (const entry of payload.entries ?? []) {
      console.log(`${entry.id}\t${entry.title ?? '(untitled)'}`);
    }
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
    } else if (item === '--scope' || item === '-s') {
      entry.scope = args[++index];
    } else if (item === '--kind' || item === '-k') {
      entry.kind = args[++index];
    } else if (!entry.content) {
      entry.content = item;
    } else {
      entry.content = `${entry.content} ${item}`;
    }
  }
  if (!entry.content) {
    throw new Error('memory capture requires content');
  }
  return entry;
}

function parseSearchArgs(args) {
  const parsed = { query: '', limit: 10 };
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (item === '--limit' || item === '-n') {
      parsed.limit = Number(args[++index] ?? 10);
    } else if (!parsed.query) {
      parsed.query = item;
    } else {
      parsed.query = `${parsed.query} ${item}`;
    }
  }
  if (!parsed.query) {
    throw new Error('memory search requires a query');
  }
  return parsed;
}

function usage() {
  console.error(`Usage:
  cortex login --issuer URL --runtime-url URL [--client-id opencortex-cli]
  cortex memory capture "text" [-t title] [-p project] [-s personal|team|global] [-k kind]
  cortex memory search "query" [-n limit]`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
