import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const defaultScopes = ['openid', 'email', 'profile', 'offline_access'];
const credentialsFile = 'tokens.json';

export function defaultCredentialsPath(env = process.env) {
  const base =
    env.OPENCORTEX_CREDENTIALS_DIR ??
    join(env.HOME ?? homedir(), '.opencortex', 'credentials');
  return join(base, credentialsFile);
}

export async function discoverOidc(issuer, fetchImpl = fetch) {
  const response = await fetchImpl(
    `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
  );
  if (!response.ok) {
    throw new Error(`OIDC discovery failed: ${response.status}`);
  }
  const metadata = await response.json();
  for (const key of ['issuer', 'token_endpoint', 'device_authorization_endpoint']) {
    if (!metadata[key]) {
      throw new Error(`OIDC discovery missing ${key}`);
    }
  }
  return metadata;
}

export async function startDeviceLogin(options, fetchImpl = fetch) {
  const metadata = await discoverOidc(options.issuer, fetchImpl);
  const body = new URLSearchParams({
    client_id: options.clientId,
    scope: (options.scopes ?? defaultScopes).join(' '),
  });
  const response = await fetchImpl(metadata.device_authorization_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error_description ?? payload.error ?? 'device login failed');
  }
  return { metadata, device: payload };
}

export async function pollDeviceToken(options, fetchImpl = fetch, sleep = delay) {
  const started = Date.now();
  let intervalMs = Number(options.device.interval ?? 5) * 1000;
  const expiresMs = Number(options.device.expires_in ?? 600) * 1000;

  while (Date.now() - started < expiresMs) {
    await sleep(intervalMs);
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: options.clientId,
      device_code: options.device.device_code,
    });
    const response = await fetchImpl(options.metadata.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const payload = await response.json();
    if (response.ok) {
      return payload;
    }
    if (payload.error === 'authorization_pending') {
      continue;
    }
    if (payload.error === 'slow_down') {
      intervalMs += 5000;
      continue;
    }
    throw new Error(payload.error_description ?? payload.error ?? 'device token polling failed');
  }
  throw new Error('device login expired');
}

export async function writeCredentials(path, credentials) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(credentials, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(tmp, path);
}

export async function readCredentials(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function mintInternalToken(options, fetchImpl = fetch) {
  const response = await fetchImpl(
    `${options.runtimeUrl.replace(/\/$/, '')}/api/auth/internal-token`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.idToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        scopes: options.scopes,
        ttlSeconds: options.ttlSeconds ?? 900,
      }),
    },
  );
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.message ?? payload.error ?? 'internal token mint failed');
  }
  return payload;
}

export async function memoryCapture(options, fetchImpl = fetch) {
  const response = await fetchImpl(
    `${options.runtimeUrl.replace(/\/$/, '')}/api/memory/entries`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.internalToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(options.entry),
    },
  );
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.message ?? payload.error ?? 'memory capture failed');
  }
  return payload;
}

export async function memorySearch(options, fetchImpl = fetch) {
  const params = new URLSearchParams({
    q: options.query,
    limit: String(options.limit ?? 10),
  });
  const response = await fetchImpl(
    `${options.runtimeUrl.replace(/\/$/, '')}/api/memory/entries?${params.toString()}`,
    { headers: { Authorization: `Bearer ${options.internalToken}` } },
  );
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.message ?? payload.error ?? 'memory search failed');
  }
  return payload;
}

export function isExpired(isoTimestamp, now = Date.now()) {
  return !isoTimestamp || new Date(isoTimestamp).getTime() <= now + 30_000;
}

export async function ensureInternalToken(options, fetchImpl = fetch) {
  const credentials = await readCredentials(options.credentialsPath);
  const cached = credentials.internalTokens?.[options.scopeKey];
  if (cached && !isExpired(cached.expiresAt, options.now)) {
    return { credentials, token: cached.token };
  }
  const minted = await mintInternalToken(
    {
      runtimeUrl: credentials.runtimeUrl,
      idToken: credentials.oidc.idToken,
      scopes: options.scopes,
    },
    fetchImpl,
  );
  const updated = {
    ...credentials,
    internalTokens: {
      ...(credentials.internalTokens ?? {}),
      [options.scopeKey]: {
        token: minted.token,
        scopes: minted.scopes,
        expiresAt: minted.expiresAt,
      },
    },
  };
  await writeCredentials(options.credentialsPath, updated);
  return { credentials: updated, token: minted.token };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
