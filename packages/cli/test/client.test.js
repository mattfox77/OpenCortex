import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureInternalToken,
  memoryCapture,
  memorySearch,
  startDeviceLogin,
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
    oidc: { idToken: 'oidc-id-token' },
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

test('calls runtime memory capture and search endpoints with internal tokens', async () => {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url, init });
    if (String(url).includes('/api/memory/entries?')) {
      assert.equal(init.headers.Authorization, 'Bearer read-token');
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
  }, fetchImpl);

  assert.equal(captured.entry.id, 'entry-1');
  assert.equal(searched.entries[0].title, 'Result');
  assert.equal(seen.length, 2);
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
