import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureInternalToken,
  memoryCapture,
  memorySearch,
  readFreshCredentials,
  refreshOidcToken,
  sessionArchive,
  sessionList,
  startDeviceLogin,
  tokenExpiresAt,
  writeCredentials,
} from '../src/client.js';

test('starts device login from OIDC discovery metadata', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (String(url).endsWith('/.well-known/openid-configuration')) {
      return jsonResponse({
        issuer: 'https://issuer.test',
        token_endpoint: 'https://issuer.test/token',
        device_authorization_endpoint: 'https://issuer.test/device',
      });
    }
    assert.equal(url, 'https://issuer.test/device');
    assert.equal(init.method, 'POST');
    assert.match(String(init.body), /client_id=opencortex-cli/);
    return jsonResponse({
      device_code: 'device-code',
      user_code: 'ABCD',
      verification_uri: 'https://issuer.test/activate',
      expires_in: 600,
      interval: 1,
    });
  };

  const result = await startDeviceLogin({
    issuer: 'https://issuer.test',
    clientId: 'opencortex-cli',
  }, fetchImpl);

  assert.equal(result.device.device_code, 'device-code');
  assert.equal(calls.length, 2);
});

test('refreshes and caches internal memory tokens', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opencortex-cli-'));
  const credentialsPath = join(dir, 'tokens.json');
  await writeCredentials(credentialsPath, {
    schemaVersion: 1,
    runtimeUrl: 'https://runtime.test/cortex',
    oidc: {
      idToken: 'oidc-id-token',
      expiresAt: '2999-01-01T00:00:00.000Z',
    },
    internalTokens: {},
  });

  const fetchImpl = async (url, init) => {
    assert.equal(url, 'https://runtime.test/cortex/api/auth/internal-token');
    assert.equal(init.headers.Authorization, 'Bearer oidc-id-token');
    assert.deepEqual(JSON.parse(init.body).scopes, ['memory:read']);
    return jsonResponse({
      token: 'internal-token',
      scopes: ['memory:read'],
      expiresAt: '2999-01-01T00:00:00.000Z',
    }, 201);
  };

  const result = await ensureInternalToken({
    credentialsPath,
    scopes: ['memory:read'],
    scopeKey: 'memory:read',
  }, fetchImpl);

  assert.equal(result.token, 'internal-token');
  const saved = JSON.parse(await readFile(credentialsPath, 'utf8'));
  assert.equal(saved.internalTokens['memory:read'].token, 'internal-token');
});

test('refreshes expired OIDC tokens before minting internal tokens', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opencortex-cli-'));
  const credentialsPath = join(dir, 'tokens.json');
  await writeCredentials(credentialsPath, {
    schemaVersion: 1,
    runtimeUrl: 'https://runtime.test/cortex',
    issuer: 'https://issuer.test',
    clientId: 'opencortex-cli',
    oidc: {
      idToken: 'expired-id-token',
      refreshToken: 'refresh-token',
      expiresAt: '2000-01-01T00:00:00.000Z',
    },
    internalTokens: {},
  });

  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (String(url).endsWith('/.well-known/openid-configuration')) {
      return jsonResponse({
        issuer: 'https://issuer.test',
        token_endpoint: 'https://issuer.test/token',
        device_authorization_endpoint: 'https://issuer.test/device',
      });
    }
    if (url === 'https://issuer.test/token') {
      assert.match(String(init.body), /grant_type=refresh_token/);
      return jsonResponse({
        id_token: 'fresh-id-token',
        access_token: 'fresh-access-token',
        refresh_token: 'fresh-refresh-token',
        expires_in: 3600,
        token_type: 'Bearer',
      });
    }
    assert.equal(url, 'https://runtime.test/cortex/api/auth/internal-token');
    assert.equal(init.headers.Authorization, 'Bearer fresh-id-token');
    return jsonResponse({
      token: 'internal-token',
      scopes: ['memory:write'],
      expiresAt: '2999-01-01T00:00:00.000Z',
    }, 201);
  };

  const result = await ensureInternalToken({
    credentialsPath,
    scopes: ['memory:write'],
    scopeKey: 'memory:write',
    now: Date.parse('2026-07-30T12:00:00.000Z'),
  }, fetchImpl);

  assert.equal(result.token, 'internal-token');
  const saved = JSON.parse(await readFile(credentialsPath, 'utf8'));
  assert.equal(saved.oidc.idToken, 'fresh-id-token');
  assert.equal(saved.oidc.refreshToken, 'fresh-refresh-token');
  assert.equal(calls.length, 3);
});

test('persists refreshed OIDC tokens even when internal tokens are cached', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opencortex-cli-'));
  const credentialsPath = join(dir, 'tokens.json');
  await writeCredentials(credentialsPath, {
    schemaVersion: 1,
    runtimeUrl: 'https://runtime.test/cortex',
    issuer: 'https://issuer.test',
    clientId: 'opencortex-cli',
    oidc: {
      idToken: 'expired-id-token',
      refreshToken: 'refresh-token',
      expiresAt: '2000-01-01T00:00:00.000Z',
    },
    internalTokens: {
      'memory:read': {
        token: 'cached-internal-token',
        scopes: ['memory:read'],
        expiresAt: '2999-01-01T00:00:00.000Z',
      },
    },
  });

  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (String(url).endsWith('/.well-known/openid-configuration')) {
      return jsonResponse({
        issuer: 'https://issuer.test',
        token_endpoint: 'https://issuer.test/token',
        device_authorization_endpoint: 'https://issuer.test/device',
      });
    }
    if (url === 'https://issuer.test/token') {
      return jsonResponse({
        id_token: 'fresh-id-token',
        refresh_token: 'fresh-refresh-token',
        expires_in: 3600,
      });
    }
    assert.equal(url, 'https://runtime.test/cortex/api/auth/internal-token');
    assert.equal(init.headers.Authorization, 'Bearer fresh-id-token');
    return jsonResponse({
      token: 'fresh-internal-token',
      scopes: ['memory:read'],
      expiresAt: '2999-01-01T00:00:00.000Z',
    }, 201);
  };

  const result = await ensureInternalToken({
    credentialsPath,
    scopes: ['memory:read'],
    scopeKey: 'memory:read',
    now: Date.parse('2026-07-30T12:00:00.000Z'),
  }, fetchImpl);

  assert.equal(result.token, 'fresh-internal-token');
  const saved = JSON.parse(await readFile(credentialsPath, 'utf8'));
  assert.equal(saved.oidc.idToken, 'fresh-id-token');
  assert.equal(saved.oidc.refreshToken, 'fresh-refresh-token');
  assert.equal(saved.internalTokens['memory:read'].token, 'fresh-internal-token');
  assert.equal(calls.length, 3);
});

test('persists refreshed OIDC tokens when reading fresh credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opencortex-cli-'));
  const credentialsPath = join(dir, 'tokens.json');
  await writeCredentials(credentialsPath, {
    schemaVersion: 1,
    runtimeUrl: 'https://runtime.test/cortex',
    issuer: 'https://issuer.test',
    clientId: 'opencortex-cli',
    oidc: {
      idToken: 'expired-id-token',
      refreshToken: 'refresh-token',
      expiresAt: '2000-01-01T00:00:00.000Z',
    },
    internalTokens: {},
  });

  const fetchImpl = async (url) => {
    if (String(url).endsWith('/.well-known/openid-configuration')) {
      return jsonResponse({
        issuer: 'https://issuer.test',
        token_endpoint: 'https://issuer.test/token',
        device_authorization_endpoint: 'https://issuer.test/device',
      });
    }
    return jsonResponse({
      id_token: 'fresh-id-token',
      refresh_token: 'fresh-refresh-token',
      expires_in: 3600,
    });
  };

  await readFreshCredentials(
    credentialsPath,
    fetchImpl,
    Date.parse('2026-07-30T12:00:00.000Z'),
  );

  const saved = JSON.parse(await readFile(credentialsPath, 'utf8'));
  assert.equal(saved.oidc.idToken, 'fresh-id-token');
  assert.equal(saved.oidc.refreshToken, 'fresh-refresh-token');
});

test('refreshes OIDC tokens with the cached refresh token', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (String(url).endsWith('/.well-known/openid-configuration')) {
      return jsonResponse({
        issuer: 'https://issuer.test',
        token_endpoint: 'https://issuer.test/token',
        device_authorization_endpoint: 'https://issuer.test/device',
      });
    }
    assert.equal(url, 'https://issuer.test/token');
    assert.match(String(init.body), /refresh_token=refresh-token/);
    return jsonResponse({ id_token: 'new-id-token', expires_in: 60 });
  };

  const result = await refreshOidcToken({
    issuer: 'https://issuer.test',
    clientId: 'opencortex-cli',
    refreshToken: 'refresh-token',
  }, fetchImpl);

  assert.equal(result.id_token, 'new-id-token');
  assert.equal(calls.length, 2);
});

test('computes token expiry timestamps', () => {
  assert.equal(
    tokenExpiresAt(60, Date.parse('2026-07-30T12:00:00.000Z')),
    '2026-07-30T12:01:00.000Z',
  );
});

test('calls runtime memory capture and search endpoints with internal tokens', async () => {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url, init });
    if (String(url).includes('/api/memory/entries?')) {
      assert.equal(init.headers.Authorization, 'Bearer read-token');
      assert.match(String(url), /q=Result/);
      assert.match(String(url), /project=runtime/);
      assert.match(String(url), /scope=team/);
      assert.match(String(url), /repo=opencortex/);
      assert.match(String(url), /includePending=true/);
      return jsonResponse({ entries: [{ id: 'entry-1', title: 'Result' }] });
    }
    assert.equal(url, 'https://runtime.test/api/memory/entries');
    assert.equal(init.headers.Authorization, 'Bearer write-token');
    assert.equal(JSON.parse(init.body).content, 'capture me');
    return jsonResponse({ entry: { id: 'entry-1' } }, 201);
  };

  const captured = await memoryCapture({
    runtimeUrl: 'https://runtime.test',
    internalToken: 'write-token',
    entry: { content: 'capture me' },
  }, fetchImpl);
  const searched = await memorySearch({
    runtimeUrl: 'https://runtime.test',
    internalToken: 'read-token',
    query: 'Result',
    project: 'runtime',
    scope: 'team',
    repo: 'opencortex',
    includePending: true,
  }, fetchImpl);

  assert.equal(captured.entry.id, 'entry-1');
  assert.equal(searched.entries[0].title, 'Result');
  assert.equal(seen.length, 2);
});

test('lists and archives runtime sessions with OIDC credentials', async () => {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url, init });
    assert.equal(init.headers.Authorization, 'Bearer oidc-id-token');
    if (init.method === 'DELETE') {
      assert.equal(url, 'https://runtime.test/api/code/sessions/session-1');
      return jsonResponse({ session: { id: 'session-1' } });
    }
    assert.equal(url, 'https://runtime.test/api/code/sessions');
    return jsonResponse({
      sessions: [{ id: 'session-1', name: 'Runtime', role: 'owner' }],
    });
  };

  const listed = await sessionList({
    runtimeUrl: 'https://runtime.test',
    idToken: 'oidc-id-token',
  }, fetchImpl);
  const archived = await sessionArchive({
    runtimeUrl: 'https://runtime.test',
    idToken: 'oidc-id-token',
    sessionId: 'session-1',
  }, fetchImpl);

  assert.equal(listed.sessions[0].id, 'session-1');
  assert.equal(archived.session.id, 'session-1');
  assert.equal(seen.length, 2);
});

test('CLI memory capture reads stdin and sends source metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opencortex-cli-'));
  const credentialsPath = join(dir, 'tokens.json');
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: JSON.parse(body),
      });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entry: { id: 'entry-stdin' } }));
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await writeCredentials(credentialsPath, {
    schemaVersion: 1,
    runtimeUrl: `http://127.0.0.1:${port}`,
    oidc: {
      idToken: 'oidc-id-token',
      expiresAt: '2999-01-01T00:00:00.000Z',
    },
    internalTokens: {
      'memory:write': {
        token: 'write-token',
        scopes: ['memory:write'],
        expiresAt: '2999-01-01T00:00:00.000Z',
      },
    },
  });

  try {
    const result = await runCli([
      'memory',
      'capture',
      '-',
      '-t',
      'Hook capture',
      '-p',
      'runtime',
      '-s',
      'personal',
      '-k',
      'document',
      '--source-system',
      'opencortex-session',
      '--session-id',
      'session-1',
      '--tool',
      'opencode',
    ], {
      env: { OPENCORTEX_CREDENTIALS_DIR: dir },
      input: 'captured from stdin',
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'entry-stdin');
    assert.deepEqual(seen, [{
      method: 'POST',
      url: '/api/memory/entries',
      authorization: 'Bearer write-token',
      body: {
        content: 'captured from stdin',
        scope: 'personal',
        kind: 'document',
        title: 'Hook capture',
        project: 'runtime',
        sourceSystem: 'opencortex-session',
        sourceSessionId: 'session-1',
        toolName: 'opencode',
      },
    }]);
  } finally {
    server.close();
  }
});

test('CLI session list and archive use cached OIDC credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opencortex-cli-'));
  const credentialsPath = join(dir, 'tokens.json');
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.method === 'DELETE') {
      res.end(JSON.stringify({ session: { id: 'session-1' } }));
      return;
    }
    res.end(JSON.stringify({
      sessions: [{
        id: 'session-1',
        role: 'owner',
        name: 'Runtime',
        ownerEmail: 'owner@acme.test',
        urlPath: '/code/session/session-1/',
      }],
    }));
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await writeCredentials(credentialsPath, {
    schemaVersion: 1,
    runtimeUrl: `http://127.0.0.1:${port}`,
    oidc: {
      idToken: 'oidc-id-token',
      expiresAt: '2999-01-01T00:00:00.000Z',
    },
    internalTokens: {},
  });

  try {
    const listed = await runCli(['session', 'list'], {
      env: { OPENCORTEX_CREDENTIALS_DIR: dir },
    });
    const archived = await runCli(['session', 'archive', 'session-1'], {
      env: { OPENCORTEX_CREDENTIALS_DIR: dir },
    });

    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /session-1\towner\tRuntime\towner@acme\.test/);
    assert.equal(archived.code, 0, archived.stderr);
    assert.equal(archived.stdout.trim(), 'session-1');
    assert.deepEqual(seen.map(item => [item.method, item.url, item.authorization]), [
      ['GET', '/api/code/sessions', 'Bearer oidc-id-token'],
      ['DELETE', '/api/code/sessions/session-1', 'Bearer oidc-id-token'],
    ]);
  } finally {
    server.close();
  }
});

test('CLI memory recall prints ranked content snippets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opencortex-cli-'));
  const credentialsPath = join(dir, 'tokens.json');
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      entries: [{
        id: 'entry-1',
        title: 'Useful finding',
        content: 'OpenCortex recall returns the actual content for context.',
        scope: 'team',
        project: 'runtime',
        repo: 'opencortex',
        score: 0.875,
      }],
    }));
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await writeCredentials(credentialsPath, {
    schemaVersion: 1,
    runtimeUrl: `http://127.0.0.1:${port}`,
    oidc: {
      idToken: 'oidc-id-token',
      expiresAt: '2999-01-01T00:00:00.000Z',
    },
    internalTokens: {
      'memory:read': {
        token: 'read-token',
        scopes: ['memory:read'],
        expiresAt: '2999-01-01T00:00:00.000Z',
      },
    },
  });

  try {
    const result = await runCli([
      'memory',
      'recall',
      'OpenCortex context',
      '-n',
      '3',
      '-p',
      'runtime',
      '-s',
      'team',
    ], {
      env: { OPENCORTEX_CREDENTIALS_DIR: dir },
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /1\. Useful finding \[team\] score=0\.875/);
    assert.match(result.stdout, /runtime \| opencortex/);
    assert.match(result.stdout, /OpenCortex recall returns the actual content/);
    assert.equal(seen[0].method, 'GET');
    assert.equal(seen[0].authorization, 'Bearer read-token');
    assert.match(seen[0].url, /q=OpenCortex\+context/);
    assert.match(seen[0].url, /limit=3/);
    assert.match(seen[0].url, /project=runtime/);
    assert.match(seen[0].url, /scope=team/);
  } finally {
    server.close();
  }
});

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

function runCli(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/index.js', ...args], {
      cwd: join(import.meta.dirname, '..'),
      env: {
        ...process.env,
        ...options.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', code => {
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(options.input ?? '');
  });
}
