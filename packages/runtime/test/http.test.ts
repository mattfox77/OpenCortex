import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http, { createServer, type Server } from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/http/app.js';
import type { AppConfig } from '../src/config/config.js';
import { SessionStore } from '../src/code/sessionStore.js';
import { ChatStore } from '../src/chat/chatStore.js';
import type { AuthenticatedUser } from '../src/auth/types.js';
import type { CodeSession } from '../src/code/sessionLauncher.js';

let server: Server | undefined;
const backendListeners: net.Server[] = [];

function testConfig(): AppConfig {
  return {
    NODE_ENV: 'test',
    PORT: 0,
    DIWAN_PUBLIC_BASE_URL: 'https://dev.dsnscript.com/diwan/',
    DIWAN_BASE_PATH: '/diwan',
    DIWAN_DATA_DIR: mkdtempSync(join(tmpdir(), 'diwan-test-')),
    OIDC_ISSUER: 'https://accounts.google.com',
    OIDC_CLIENT_ID: 'client',
    OIDC_CLIENT_SECRET: '',
    OIDC_REDIRECT_PATH: '/auth/callback',
    OIDC_REQUIRED_GROUPS: ['TeamChatUsers', 'OpenCodeUsers'],
    OIDC_GROUPS_CLAIM: 'groups',
    OIDC_SCOPES: ['openid', 'email', 'profile'],
    OIDC_AUTHORIZATION_ENDPOINT: 'https://accounts.google.com/o/oauth2/v2/auth',
    OIDC_TOKEN_ENDPOINT: 'https://oauth2.googleapis.com/token',
    OIDC_JWKS_URI: 'https://www.googleapis.com/oauth2/v3/certs',
    OIDC_END_SESSION_ENDPOINT: '',
    COGNITO_REGION: 'us-east-1',
    COGNITO_USER_POOL_ID: 'us-east-1_test',
    COGNITO_APP_CLIENT_ID: 'client',
    COGNITO_DOMAIN: 'https://example.auth.us-east-1.amazoncognito.com',
    COGNITO_REDIRECT_PATH: '/auth/callback',
    COGNITO_REQUIRED_GROUPS: ['TeamChatUsers', 'OpenCodeUsers'],
    DIWAN_ALLOWED_EMAIL_DOMAIN: 'dsn.com',
    DIWAN_ALLOWED_EMAIL_DOMAINS: ['dsn.com'],
    DIWAN_SUPER_ADMIN_EMAILS: ['mfox@dsn.com'],
    DIWAN_LINUX_USER_PREFIX: '',
    DIWAN_WORKSPACE_ROOT: '/srv/diwan/workspaces',
    DIWAN_EXEC_MODE: 'dry-run',
    DIWAN_OPENCODE_PORT_BASE: 4100,
    DIWAN_OPENCODE_BIN: '/usr/local/bin/opencode',
    DIWAN_PROVISION_USER_SCRIPT: '/opt/opencortex/scripts/provision-diwan-user.sh',
    DIWAN_AWS_REGION: 'us-east-1',
    DIWAN_SSM_TARGET_INSTANCE_ID: '',
    DIWAN_SSM_LOCAL_PORT_BASE: 5100,
    DIWAN_AWS_BIN: '/usr/local/bin/aws',
    DIWAN_JIRA_BASE_URL: 'https://dsnsoft-dev.atlassian.net',
    SLACK_BOT_TOKEN: '',
    SLACK_API_BASE_URL: 'https://slack.com/api',
    SLACK_WORKSPACE_URL: 'https://workspace.example.com',
    SLACK_SESSION_CHANNEL_PREFIX: 'diwan',
  };
}

async function request(path: string) {
  const app = createApp(testConfig());
  server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected TCP listener');
  return fetch(`http://127.0.0.1:${address.port}${path}`);
}

function startApp(config: AppConfig) {
  const app = createApp(config);
  const listener = app.listen(0);
  const address = listener.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected TCP listener');
  const base = `http://127.0.0.1:${address.port}`;
  return { listener, base };
}

function listenOnEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Expected TCP address'));
        return;
      }
      backendListeners.push(srv);
      resolve(address.port);
    });
  });
}

function listenOnHttpBackend(
  handler: Parameters<typeof createServer>[0],
): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer(handler);
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Expected TCP address'));
        return;
      }
      backendListeners.push(srv);
      resolve(address.port);
    });
  });
}

function authUser(email: string): AuthenticatedUser {
  const linuxUser = email.split('@')[0];
  return {
    sub: `dev:${email}`,
    email,
    groups: ['TeamChatUsers', 'OpenCodeUsers'],
    linuxUser,
  };
}

function codeSession(overrides: Partial<CodeSession>): CodeSession {
  return {
    id: 'live',
    createdAt: new Date().toISOString(),
    ownerEmail: 'owner@dsn.com',
    linuxUser: 'owner',
    workspaceDir: '/home/owner/repos',
    port: 4100,
    urlPath: '/diwan/code/session/live/',
    command: ['opencode', 'web'],
    mode: 'sudo',
    ...overrides,
  };
}

function fakeDyson(
  handler: http.RequestListener,
): Promise<{ port: number; requests: Array<{ url?: string; body: string }> }> {
  const requests: Array<{ url?: string; body: string }> = [];
  const listener = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      requests.push({
        url: req.url,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      handler(req, res);
    });
  });
  backendListeners.push(listener);
  return new Promise((resolve, reject) => {
    listener.on('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Expected TCP listener'));
        return;
      }
      resolve({ port: address.port, requests });
    });
  });
}

afterEach(() => {
  server?.close();
  server = undefined;
  for (const listener of backendListeners.splice(0)) {
    listener.close();
  }
});

describe('http app', () => {
  it('serves the UI on the OIDC callback path', async () => {
    const response = await request('/diwan/auth/callback?code=test-code');

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<base href="/diwan/" />');
    expect(html).toContain('<title>OpenCortex Runtime</title>');
    expect(html).toContain('<h1>AI Engineering Workspace</h1>');
    expect(html).toContain('<h2>DysonCode</h2>');
    expect(html).not.toContain('<h2>OpenCode</h2>');
  });

  it('serves the TeamChat shell for standalone DysonCode session tabs', async () => {
    const response = await request('/diwan/code/sessions/live');

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<base href="/diwan/" />');
    expect(html).toContain('<h2 id="channel-title">TeamChat</h2>');
    expect(html).toContain('<h2>DysonCode</h2>');
  });

  it('serves the profile page through the app shell', async () => {
    const response = await request('/diwan/profile');

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<section id="profile-page"');
    expect(html).toContain('<button id="sign-in"');
    expect(html).toContain('<button id="sign-out"');
  });

  it('returns auth config with the mounted callback URL', async () => {
    const response = await request('/diwan/api/auth/config');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      clientId: 'client',
      redirectUri: 'https://dev.dsnscript.com/diwan/auth/callback',
      logoutUrl: 'https://dev.dsnscript.com/diwan/',
      basePath: '/diwan',
      scope: 'openid email profile',
    });
  });

  it('exchanges OIDC auth codes with the configured token endpoint', async () => {
    const tokenBackend = await fakeDyson((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        id_token: 'id-token',
        access_token: 'access-token',
        expires_in: 3600,
        token_type: 'Bearer',
      }));
    });
    const config: AppConfig = {
      ...testConfig(),
      OIDC_CLIENT_SECRET: 'client-secret',
      OIDC_TOKEN_ENDPOINT: `http://127.0.0.1:${tokenBackend.port}/token`,
    };
    const { listener, base } = startApp(config);
    server = listener;

    const response = await fetch(`${base}/diwan/api/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'auth-code', codeVerifier: 'pkce-verifier' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      idToken: 'id-token',
      accessToken: 'access-token',
      expiresIn: 3600,
      tokenType: 'Bearer',
    });
    expect(tokenBackend.requests).toHaveLength(1);
    const form = new URLSearchParams(tokenBackend.requests[0].body);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('client_id')).toBe('client');
    expect(form.get('client_secret')).toBe('client-secret');
    expect(form.get('redirect_uri')).toBe(
      'https://dev.dsnscript.com/diwan/auth/callback',
    );
    expect(form.get('code')).toBe('auth-code');
    expect(form.get('code_verifier')).toBe('pkce-verifier');
  });

  it('requires auth to list code sessions', async () => {
    const response = await request('/diwan/api/code/sessions');
    expect(response.status).toBe(401);
  });

  it('restores a previously created session on a later GET (same server)', async () => {
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const { listener, base } = startApp(config);
    server = listener;

    const devAuth = { Authorization: 'Dev tester@dsn.com' };

    const created = await fetch(`${base}/diwan/api/code/sessions`, {
      method: 'POST',
      headers: devAuth,
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.session.id).toBeTruthy();
    expect(createdBody.session.ownerEmail).toBe('tester@dsn.com');

    // A fresh request (simulating a page refresh) sees the same session.
    const listed = await fetch(`${base}/diwan/api/code/sessions`, {
      headers: devAuth,
    });
    expect(listed.status).toBe(200);
    const listedBody = await listed.json();
    expect(listedBody.sessions).toHaveLength(1);
    expect(listedBody.sessions[0].id).toBe(createdBody.session.id);
  });

  it('reuses one persisted Code Workspace for repeated opens by a user', async () => {
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const { listener, base } = startApp(config);
    server = listener;

    const devAuth = { Authorization: 'Dev tester@dsn.com' };

    const first = await fetch(`${base}/diwan/api/code/sessions`, {
      method: 'POST',
      headers: devAuth,
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json();

    const second = await fetch(`${base}/diwan/api/code/sessions`, {
      method: 'POST',
      headers: devAuth,
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json();

    const listed = await fetch(`${base}/diwan/api/code/sessions`, {
      headers: devAuth,
    });
    const listedBody = await listed.json();

    expect(secondBody.session.id).toBe(firstBody.session.id);
    expect(listedBody.sessions.map((item: { id: string }) => item.id)).toEqual([
      firstBody.session.id,
    ]);
  });

  it('lists a persisted live session with its channel after an app restart', async () => {
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const livePort = await listenOnEphemeralPort();
    const session = codeSession({ id: 'live', port: livePort });
    const initialSessions = new SessionStore(config.DIWAN_DATA_DIR);
    const initialChat = new ChatStore(config);
    const channel = initialChat.ensureSessionChannel(
      session,
      authUser('owner@dsn.com'),
    );
    initialSessions.set(session.id, session);

    const restartedSessions = new SessionStore(config.DIWAN_DATA_DIR);
    await restartedSessions.init();
    const restartedChat = new ChatStore(config);
    const app = createApp(config, restartedSessions, restartedChat);
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP listener');
    }

    const listed = await fetch(
      `http://127.0.0.1:${address.port}/diwan/api/code/sessions`,
      { headers: { Authorization: 'Dev owner@dsn.com' } },
    );

    expect(listed.status).toBe(200);
    const listedBody = await listed.json();
    expect(listedBody.sessions).toHaveLength(1);
    expect(listedBody.sessions[0]).toMatchObject({
      id: 'live',
      channel: { id: channel.id },
    });
  });

  it('relaunches a persisted session whose backend stopped while the owner was away', async () => {
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const deadPort = await listenOnEphemeralPort();
    backendListeners.splice(0).forEach(listener => listener.close());
    const session = codeSession({
      id: 'workspace-owner',
      port: deadPort,
      mode: 'sudo',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const sessions = new SessionStore(config.DIWAN_DATA_DIR);
    const chat = new ChatStore(config);
    const channel = chat.ensureSessionChannel(
      session,
      authUser('owner@dsn.com'),
    );
    sessions.set(session.id, session);

    const app = createApp(config, sessions, chat);
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP listener');
    }

    const listed = await fetch(
      `http://127.0.0.1:${address.port}/diwan/api/code/sessions`,
      { headers: { Authorization: 'Dev owner@dsn.com' } },
    );

    expect(listed.status).toBe(200);
    const listedBody = await listed.json();
    expect(listedBody.sessions).toHaveLength(1);
    expect(listedBody.sessions[0]).toMatchObject({
      id: 'workspace-owner',
      mode: 'dry-run',
      createdAt: '2026-01-01T00:00:00.000Z',
      channel: { id: channel.id },
    });
    expect(sessions.get('workspace-owner')?.mode).toBe('dry-run');
    expect(
      chat.getChannelForUser(channel.id, authUser('owner@dsn.com'))?.archivedAt,
    ).toBeUndefined();
  });

  it("does not leak another user's sessions", async () => {
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const { listener, base } = startApp(config);
    server = listener;

    await fetch(`${base}/diwan/api/code/sessions`, {
      method: 'POST',
      headers: { Authorization: 'Dev owner@dsn.com' },
    });

    const other = await fetch(`${base}/diwan/api/code/sessions`, {
      headers: { Authorization: 'Dev someone-else@dsn.com' },
    });
    expect(other.status).toBe(200);
    const body = await other.json();
    expect(body.sessions).toHaveLength(0);
  });

  it("lets super admins see everyone else's sessions and untagged activity", async () => {
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const { listener, base } = startApp(config);
    server = listener;

    const ownerAuth = { Authorization: 'Dev grathke@dsn.com' };
    const superAdminAuth = { Authorization: 'Dev mfox@dsn.com' };

    const created = await fetch(`${base}/diwan/api/code/sessions`, {
      method: 'POST',
      headers: ownerAuth,
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();

    const listed = await fetch(`${base}/diwan/api/code/sessions`, {
      headers: superAdminAuth,
    });
    expect(listed.status).toBe(200);
    const listedBody = await listed.json();
    expect(listedBody.sessions).toMatchObject([
      {
        id: createdBody.session.id,
        ownerEmail: 'grathke@dsn.com',
      },
    ]);

    const activity = await fetch(`${base}/diwan/api/work-tracking/sessions`, {
      headers: superAdminAuth,
    });
    expect(activity.status).toBe(200);
    const activityBody = await activity.json();
    expect(activityBody.sessions).toMatchObject([
      {
        id: createdBody.session.id,
        ownerEmail: 'grathke@dsn.com',
      },
    ]);
  });

  it('creates private session channels and shares them with members', async () => {
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const { listener, base } = startApp(config);
    server = listener;

    const ownerAuth = {
      Authorization: 'Dev owner@dsn.com',
      'Content-Type': 'application/json',
    };
    const otherAuth = { Authorization: 'Dev other@dsn.com' };

    const created = await fetch(`${base}/diwan/api/code/sessions`, {
      method: 'POST',
      headers: ownerAuth,
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.channel.visibility).toBe('private');

    const beforeShare = await fetch(`${base}/diwan/api/chat/channels`, {
      headers: otherAuth,
    });
    const beforeShareBody = await beforeShare.json();
    expect(
      beforeShareBody.channels.map((channel: { id: string }) => channel.id),
    ).not.toContain(createdBody.channel.id);

    const shared = await fetch(
      `${base}/diwan/api/chat/channels/${createdBody.channel.id}/share`,
      {
        method: 'POST',
        headers: ownerAuth,
        body: JSON.stringify({ email: 'other@dsn.com' }),
      },
    );
    expect(shared.status).toBe(200);

    const afterShare = await fetch(`${base}/diwan/api/chat/channels`, {
      headers: otherAuth,
    });
    const afterShareBody = await afterShare.json();
    expect(
      afterShareBody.channels.map((channel: { id: string }) => channel.id),
    ).toContain(createdBody.channel.id);

    const posted = await fetch(
      `${base}/diwan/api/chat/channels/${createdBody.channel.id}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Dev other@dsn.com',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body: 'I can collaborate here' }),
      },
    );
    expect(posted.status).toBe(201);
  });

  it('archives stale TeamChat session channels before listing channels', async () => {
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const createdAt = new Date().toISOString();
    const oldThread = {
      id: 'thread-old',
      openCodeSessionId: 'ses_old',
      createdAt,
      lastSelectedAt: createdAt,
    };
    const liveThread = {
      id: 'thread-live',
      openCodeSessionId: 'ses_live',
      createdAt,
      lastSelectedAt: createdAt,
    };
    const session = codeSession({
      id: 'live',
      openCodeSessionId: 'ses_live',
      activeThreadId: liveThread.id,
      threads: [liveThread],
    });
    const sessions = new SessionStore(config.DIWAN_DATA_DIR);
    const chat = new ChatStore(config);
    const owner = authUser('owner@dsn.com');
    sessions.set(session.id, session);
    const stale = chat.ensureSessionChannel(
      {
        ...session,
        openCodeSessionId: 'ses_old',
        activeThreadId: oldThread.id,
        threads: [oldThread],
      },
      owner,
    );
    const live = chat.ensureSessionChannel(session, owner);

    const app = createApp(config, sessions, chat);
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP listener');
    }

    const response = await fetch(
      `http://127.0.0.1:${address.port}/diwan/api/chat/channels`,
      { headers: { Authorization: 'Dev owner@dsn.com' } },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    const staleChannel = body.channels.find(
      (channel: { id: string }) => channel.id === stale.id,
    );
    const liveChannel = body.channels.find(
      (channel: { id: string }) => channel.id === live.id,
    );
    expect(staleChannel.archivedAt).toEqual(expect.any(String));
    expect(staleChannel.session.sessionId).toBeUndefined();
    expect(liveChannel.archivedAt).toBeUndefined();
    expect(liveChannel.session.openCodeSessionId).toBe('ses_live');
  });

  it('creates a Slack channel for new sessions when Slack is configured', async () => {
    const slack = await fakeDyson((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/conversations.create') {
        res.end(
          JSON.stringify({
            ok: true,
            channel: { id: 'CSESSION', name: 'diwan-owner-live' },
          }),
        );
        return;
      }
      if (req.url === '/chat.postMessage') {
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.end(JSON.stringify({ ok: false, error: 'unexpected_method' }));
    });
    const config: AppConfig = {
      ...testConfig(),
      NODE_ENV: 'development',
      SLACK_BOT_TOKEN: 'xoxb-test',
      SLACK_API_BASE_URL: `http://127.0.0.1:${slack.port}`,
    };
    const { listener, base } = startApp(config);
    server = listener;

    const created = await fetch(`${base}/diwan/api/code/sessions`, {
      method: 'POST',
      headers: { Authorization: 'Dev owner@dsn.com' },
    });

    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.channel.external.slack).toMatchObject({
      channelId: 'CSESSION',
      channelName: 'diwan-owner-live',
      url: 'https://workspace.example.com/archives/CSESSION',
    });
    expect(slack.requests.map(request => request.url)).toEqual([
      '/conversations.create',
      '/chat.postMessage',
    ]);
  });

  it('updates session channel names from dyson-opencode session metadata', async () => {
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const backendPort = await listenOnHttpBackend((req, res) => {
      if (req.url === '/api/session/ses_live') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { session: { title: 'Greeting' } } }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
    const session = codeSession({
      id: 'live',
      openCodeSessionId: 'ses_live',
      port: backendPort,
    });
    const sessions = new SessionStore(config.DIWAN_DATA_DIR);
    const chat = new ChatStore(config);
    sessions.set(session.id, session);
    const channel = chat.ensureSessionChannel(
      session,
      authUser('owner@dsn.com'),
    );
    expect(channel.name).toBe('New session');

    const app = createApp(config, sessions, chat);
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP listener');
    }

    const response = await fetch(
      `http://127.0.0.1:${address.port}/diwan/api/chat/channels`,
      { headers: { Authorization: 'Dev owner@dsn.com' } },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(
      body.channels.find((item: { id: string }) => item.id === channel.id).name,
    ).toBe('Greeting');
  });

  it('syncs TeamChat session channels from the dyson-opencode session inventory', async () => {
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const backendPort = await listenOnHttpBackend((req, res) => {
      if (req.url === '/api/session') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            data: {
              sessions: [
                {
                  id: 'ses_pull',
                  title: 'Pull dsn-dsnpay-core',
                  project: { path: '/home/owner/repos/dsn-dsnpay-core' },
                },
                {
                  id: 'ses_clone',
                  title: 'Clone DSN-dev/dsn-dsnpay-core',
                  cwd: '/home/owner/repos/dsn-dsnpay-core',
                },
              ],
            },
          }),
        );
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
    const session = codeSession({
      id: 'live',
      openCodeSessionId: 'ses_generated',
      port: backendPort,
    });
    const sessions = new SessionStore(config.DIWAN_DATA_DIR);
    const chat = new ChatStore(config);
    const owner = authUser('owner@dsn.com');
    sessions.set(session.id, session);
    const staleChannel = chat.ensureSessionChannel(session, owner);

    const app = createApp(config, sessions, chat);
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP listener');
    }

    const response = await fetch(
      `http://127.0.0.1:${address.port}/diwan/api/code/sessions`,
      { headers: { Authorization: 'Dev owner@dsn.com' } },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    const syncedSessions = body.sessions.map(
      (item: {
        channel: { name: string; session: { workspaceDir: string } };
        openCodeSessionId: string;
      }) => ({
        name: item.channel.name,
        openCodeSessionId: item.openCodeSessionId,
        workspaceDir: item.channel.session.workspaceDir,
      }),
    );
    expect(syncedSessions).toHaveLength(2);
    expect(syncedSessions).toEqual(
      expect.arrayContaining([
        {
          name: 'Pull dsn-dsnpay-core',
          openCodeSessionId: 'ses_pull',
          workspaceDir: '/home/owner/repos/dsn-dsnpay-core',
        },
        {
          name: 'Clone DSN-dev/dsn-dsnpay-core',
          openCodeSessionId: 'ses_clone',
          workspaceDir: '/home/owner/repos/dsn-dsnpay-core',
        },
      ]),
    );

    const openCodeSessionIds = body.sessions.map(
      (item: { channel: { session: { openCodeSessionId: string } } }) =>
        item.channel.session.openCodeSessionId,
    );
    expect(openCodeSessionIds).toHaveLength(2);
    expect(openCodeSessionIds).toEqual(
      expect.arrayContaining(['ses_pull', 'ses_clone']),
    );
    expect(
      chat.getChannelForUser(staleChannel.id, owner)?.archivedAt,
    ).toBeTruthy();
  });

  it('tracks a selected DysonCode thread from proxied navigation without changing the active thread', async () => {
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const backendPort = await listenOnHttpBackend((req, res) => {
      if (req.url === '/api/session/ses_existing') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ data: { session: { title: 'Persisted Thread' } } }),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head></head><body>OpenCode</body></html>');
    });
    const session = codeSession({
      id: 'live',
      openCodeSessionId: 'ses_generated',
      port: backendPort,
    });
    const sessions = new SessionStore(config.DIWAN_DATA_DIR);
    const chat = new ChatStore(config);
    sessions.set(session.id, session);
    const channel = chat.ensureSessionChannel(
      session,
      authUser('owner@dsn.com'),
    );
    expect(channel.name).toBe('New session');

    const app = createApp(config, sessions, chat);
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP listener');
    }
    const base = `http://127.0.0.1:${address.port}`;
    const cookie = {
      Cookie: `diwan.idToken=${encodeURIComponent('Dev owner@dsn.com')}`,
    };
    const projectPath = '/home/owner/repos/dsn-dsnpay-core';
    const encodedProjectPath = Buffer.from(projectPath)
      .toString('base64')
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');

    const opened = await fetch(
      `${base}/diwan/code/session/live/${encodedProjectPath}/session/ses_existing`,
      { headers: cookie },
    );
    expect(opened.status).toBe(200);
    expect(sessions.get('live')?.openCodeSessionId).toBe('ses_generated');
    expect(sessions.get('live')?.workspaceDir).toBe('/home/owner/repos');
    expect(sessions.get('live')?.threads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          openCodeSessionId: 'ses_existing',
          workspaceDir: projectPath,
        }),
      ]),
    );

    const listed = await fetch(`${base}/diwan/api/code/sessions`, {
      headers: { Authorization: 'Dev owner@dsn.com' },
    });
    const listedBody = await listed.json();
    const selected = listedBody.sessions.find(
      (item: { openCodeSessionId: string }) =>
        item.openCodeSessionId === 'ses_existing',
    );
    expect(selected.channel).toMatchObject({
      name: 'Persisted Thread',
      session: {
        sessionId: 'live',
        openCodeSessionId: 'ses_existing',
        workspaceDir: projectPath,
      },
    });
    expect(selected.workspaceDir).toBe(projectPath);
    expect(selected.channel.id).not.toBe(channel.id);
  });

  it('lists every live DysonCode thread channel with a runnable workspace URL', async () => {
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const backendPort = await listenOnHttpBackend((req, res) => {
      if (req.url === '/api/session/ses_one') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { session: { title: 'Thread One' } } }));
        return;
      }
      if (req.url === '/api/session/ses_two') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { session: { title: 'Thread Two' } } }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
    const sessions = new SessionStore(config.DIWAN_DATA_DIR);
    const chat = new ChatStore(config);
    const owner = authUser('owner@dsn.com');
    const createdAt = new Date().toISOString();
    const baseSession = codeSession({
      id: 'live',
      openCodeSessionId: 'ses_one',
      activeThreadId: 'thread-one',
      port: backendPort,
      threads: [
        {
          id: 'thread-one',
          openCodeSessionId: 'ses_one',
          createdAt,
          lastSelectedAt: createdAt,
        },
        {
          id: 'thread-two',
          openCodeSessionId: 'ses_two',
          createdAt,
          lastSelectedAt: createdAt,
        },
      ],
    });
    sessions.set(baseSession.id, baseSession);
    const first = chat.ensureSessionChannel(baseSession, owner);
    chat.ensureSessionChannel(
      {
        ...baseSession,
        openCodeSessionId: 'ses_two',
        activeThreadId: 'thread-two',
      },
      owner,
    );

    const app = createApp(config, sessions, chat);
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP listener');
    }

    const listed = await fetch(
      `http://127.0.0.1:${address.port}/diwan/api/code/sessions`,
      { headers: { Authorization: 'Dev owner@dsn.com' } },
    );

    expect(listed.status).toBe(200);
    const body = await listed.json();
    expect(
      body.sessions
        .map((item: { openCodeSessionId: string }) => item.openCodeSessionId)
        .sort(),
    ).toEqual(['ses_one', 'ses_two']);
    expect(
      body.sessions
        .map((item: { channel: { name: string } }) => item.channel.name)
        .sort(),
    ).toEqual(['Thread One', 'Thread Two']);
    expect(
      body.sessions.every(
        (item: {
          id: string;
          channel: { id: string };
          openCodeSessionId: string;
        }) =>
          item.id === 'live' &&
          item.channel.id &&
          item.openCodeSessionId.startsWith('ses_'),
      ),
    ).toBe(true);
    expect(
      body.sessions.map((item: { channel: { id: string } }) => item.channel.id),
    ).toContain(first.id);
  });

  it('redirects raw DysonCode thread URLs back into the managed session proxy', async () => {
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const sessions = new SessionStore(config.DIWAN_DATA_DIR);
    const chat = new ChatStore(config);
    const owner = authUser('owner@dsn.com');
    const workspaceDir = '/home/owner/repos/dsn-dsnpay-core';
    const createdAt = new Date().toISOString();
    const session = codeSession({
      id: 'live',
      openCodeSessionId: 'ses_existing',
      threads: [
        {
          id: 'thread-existing',
          openCodeSessionId: 'ses_existing',
          workspaceDir,
          createdAt,
          lastSelectedAt: createdAt,
        },
      ],
    });
    sessions.set(session.id, session);
    chat.ensureSessionChannel(session, owner);

    const app = createApp(config, sessions, chat);
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP listener');
    }
    const base = `http://127.0.0.1:${address.port}`;
    const workspaceToken = Buffer.from(workspaceDir)
      .toString('base64')
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');

    const response = await fetch(
      `${base}/diwan/${workspaceToken}/session/ses_existing`,
      {
        headers: {
          Cookie: `diwan.idToken=${encodeURIComponent('Dev owner@dsn.com')}`,
        },
        redirect: 'manual',
      },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      `/diwan/code/session/live/${workspaceToken}/session/ses_existing`,
    );
  });

  it('opens different DysonCode session links without changing the active thread globally', async () => {
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const backendPort = await listenOnHttpBackend((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html><head></head><body>${req.url}</body></html>`);
    });
    const sessions = new SessionStore(config.DIWAN_DATA_DIR);
    const chat = new ChatStore(config);
    const owner = authUser('owner@dsn.com');
    const createdAt = new Date().toISOString();
    const workspaceOne = '/home/owner/repos/one';
    const workspaceTwo = '/home/owner/repos/two';
    const tokenOne = Buffer.from(workspaceOne)
      .toString('base64')
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');
    const tokenTwo = Buffer.from(workspaceTwo)
      .toString('base64')
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');
    const session = codeSession({
      id: 'live',
      port: backendPort,
      openCodeSessionId: 'ses_one',
      activeThreadId: 'thread-one',
      threads: [
        {
          id: 'thread-one',
          openCodeSessionId: 'ses_one',
          workspaceDir: workspaceOne,
          createdAt,
          lastSelectedAt: createdAt,
        },
        {
          id: 'thread-two',
          openCodeSessionId: 'ses_two',
          workspaceDir: workspaceTwo,
          createdAt,
          lastSelectedAt: createdAt,
        },
      ],
    });
    sessions.set(session.id, session);
    chat.ensureSessionChannel(session, owner);

    const app = createApp(config, sessions, chat);
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP listener');
    }
    const base = `http://127.0.0.1:${address.port}`;
    const cookie = {
      Cookie: `diwan.idToken=${encodeURIComponent('Dev owner@dsn.com')}`,
    };

    const first = await fetch(
      `${base}/diwan/code/session/live/${tokenOne}/session/ses_one`,
      { headers: cookie },
    );
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('/session/ses_one');
    expect(sessions.get('live')?.openCodeSessionId).toBe('ses_one');

    const second = await fetch(
      `${base}/diwan/code/session/live/${tokenTwo}/session/ses_two`,
      { headers: cookie },
    );
    expect(second.status).toBe(200);
    expect(await second.text()).toContain('/session/ses_two');
    expect(sessions.get('live')?.openCodeSessionId).toBe('ses_one');
    expect(sessions.get('live')?.activeThreadId).toBe('thread-one');
    expect(
      sessions
        .get('live')
        ?.threads?.find(thread => thread.id === 'thread-two')?.workspaceDir,
    ).toBe(workspaceTwo);
  });

  it('tracks Jira items from session chat and searches sessions by item', async () => {
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const { listener, base } = startApp(config);
    server = listener;

    const ownerAuth = {
      Authorization: 'Dev owner@dsn.com',
      'Content-Type': 'application/json',
    };
    const created = await fetch(`${base}/diwan/api/code/sessions`, {
      method: 'POST',
      headers: ownerAuth,
    });
    const createdBody = await created.json();

    const posted = await fetch(
      `${base}/diwan/api/chat/channels/${createdBody.channel.id}/messages`,
      {
        method: 'POST',
        headers: ownerAuth,
        body: JSON.stringify({ body: 'Starting DSN-321 now' }),
      },
    );
    expect(posted.status).toBe(201);

    const links = await fetch(
      `${base}/diwan/api/code/sessions/${createdBody.session.id}/jira-links`,
      { headers: ownerAuth },
    );
    expect(links.status).toBe(200);
    const linksBody = await links.json();
    expect(linksBody.links).toMatchObject([
      { kind: 'issue', targetKey: 'DSN-321', source: 'chat-message' },
    ]);

    const searched = await fetch(
      `${base}/diwan/api/work-tracking/sessions?jiraKey=DSN-321`,
      { headers: ownerAuth },
    );
    expect(searched.status).toBe(200);
    const searchedBody = await searched.json();
    expect(searchedBody.sessions).toHaveLength(1);
    expect(searchedBody.sessions[0].id).toBe(createdBody.session.id);

    const detail = await fetch(
      `${base}/diwan/api/work-tracking/jira-items/DSN-321`,
      { headers: ownerAuth },
    );
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody).toMatchObject({
      key: 'DSN-321',
      item: {
        key: 'DSN-321',
        projectKey: 'DSN',
      },
      sourceCounts: {
        'chat-message': 1,
      },
    });
    expect(detailBody.links).toHaveLength(1);
    expect(detailBody.sessions[0].id).toBe(createdBody.session.id);
    expect(detailBody.integrationFormat.descriptionSection).toContain(
      '## Diwan Integration',
    );
  });

  it('lets shared session members manually tag teams and search by team', async () => {
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const { listener, base } = startApp(config);
    server = listener;

    const ownerAuth = {
      Authorization: 'Dev owner@dsn.com',
      'Content-Type': 'application/json',
    };
    const memberAuth = {
      Authorization: 'Dev member@dsn.com',
      'Content-Type': 'application/json',
    };
    const created = await fetch(`${base}/diwan/api/code/sessions`, {
      method: 'POST',
      headers: ownerAuth,
    });
    const createdBody = await created.json();
    await fetch(
      `${base}/diwan/api/chat/channels/${createdBody.channel.id}/share`,
      {
        method: 'POST',
        headers: ownerAuth,
        body: JSON.stringify({ email: 'member@dsn.com' }),
      },
    );

    const tagged = await fetch(
      `${base}/diwan/api/code/sessions/${createdBody.session.id}/jira-links`,
      {
        method: 'POST',
        headers: memberAuth,
        body: JSON.stringify({ reference: 'Platform Team', kind: 'team' }),
      },
    );
    expect(tagged.status).toBe(201);
    const taggedBody = await tagged.json();
    expect(taggedBody.links).toMatchObject([
      {
        kind: 'team',
        teamName: 'Platform Team',
        createdByEmail: 'member@dsn.com',
      },
    ]);

    const searched = await fetch(
      `${base}/diwan/api/work-tracking/sessions?teamName=Platform%20Team`,
      { headers: memberAuth },
    );
    expect(searched.status).toBe(200);
    const searchedBody = await searched.json();
    expect(
      searchedBody.sessions.map((item: { id: string }) => item.id),
    ).toEqual([createdBody.session.id]);
  });

  it('restricts proxied OpenCode sessions to owners and shared members', async () => {
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const { listener, base } = startApp(config);
    server = listener;

    const ownerAuth = {
      Authorization: 'Dev owner@dsn.com',
      'Content-Type': 'application/json',
    };
    const created = await fetch(`${base}/diwan/api/code/sessions`, {
      method: 'POST',
      headers: ownerAuth,
    });
    const createdBody = await created.json();
    const sessionPath = `${base}${createdBody.session.urlPath}`;

    const unrelated = await fetch(sessionPath, {
      headers: {
        Cookie: `diwan.idToken=${encodeURIComponent('Dev unrelated@dsn.com')}`,
      },
    });
    expect(unrelated.status).toBe(404);

    await fetch(
      `${base}/diwan/api/chat/channels/${createdBody.channel.id}/share`,
      {
        method: 'POST',
        headers: ownerAuth,
        body: JSON.stringify({ email: 'other@dsn.com' }),
      },
    );

    const shared = await fetch(sessionPath, {
      headers: {
        Cookie: `diwan.idToken=${encodeURIComponent('Dev other@dsn.com')}`,
      },
    });
    // dry-run mode does not start an OpenCode backend, so an authorized proxy
    // request reaches the proxy and fails upstream instead of being hidden.
    expect(shared.status).toBe(502);
  });

  it('rebrands proxied OpenCode browser assets to DysonCode', async () => {
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const backendPort = await listenOnHttpBackend((req, res) => {
      if (req.url === '/assets/app.js') {
        res.writeHead(200, {
          'content-type': 'application/javascript',
          etag: 'test-etag',
        });
        res.end('document.title = "OpenCode";');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        '<html><head><title>OpenCode</title></head><body>OpenCode</body></html>',
      );
    });
    const session = codeSession({ id: 'live', port: backendPort });
    const sessions = new SessionStore(config.DIWAN_DATA_DIR);
    const chat = new ChatStore(config);
    sessions.set(session.id, session);
    const channel = chat.ensureSessionChannel(
      session,
      authUser('owner@dsn.com'),
    );
    chat.attachSlackChannel(channel.id, {
      channelId: 'CSESSION',
      channelName: 'diwan-owner-live',
      url: 'https://workspace.example.com/archives/CSESSION',
    });
    const app = createApp(config, sessions, chat);
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP listener');
    }
    const base = `http://127.0.0.1:${address.port}`;
    const cookie = {
      Cookie: `diwan.idToken=${encodeURIComponent('Dev owner@dsn.com')}`,
    };

    const html = await fetch(`${base}/diwan/code/session/live/`, {
      headers: cookie,
    });
    expect(html.status).toBe(200);
    expect(html.headers.get('etag')).toBeNull();
    const htmlBody = await html.text();
    expect(htmlBody).toContain('DysonCode');
    expect(htmlBody).toContain('data-diwan-session-addon');
    expect(htmlBody).toContain('data-channel-id="');
    expect(htmlBody).toContain('data-diwan-url="/diwan/code/sessions/live"');
    expect(htmlBody).toContain(
      'data-slack-url="https://workspace.example.com/archives/CSESSION"',
    );
    expect(htmlBody).toContain('/diwan/diwan-session-addon.js');

    const js = await fetch(`${base}/diwan/code/session/live/assets/app.js`, {
      headers: cookie,
    });
    expect(js.status).toBe(200);
    expect(js.headers.get('etag')).toBeNull();
    await expect(js.text()).resolves.toBe('document.title = "DysonCode";');
  });

  it('runs pair prompt review lifecycle for shared session members', async () => {
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const { listener, base } = startApp(config);
    server = listener;

    const ownerAuth = {
      Authorization: 'Dev owner@dsn.com',
      'Content-Type': 'application/json',
    };
    const reviewerAuth = {
      Authorization: 'Dev reviewer@dsn.com',
      'Content-Type': 'application/json',
    };

    const created = await fetch(`${base}/diwan/api/code/sessions`, {
      method: 'POST',
      headers: ownerAuth,
    });
    const createdBody = await created.json();
    await fetch(
      `${base}/diwan/api/chat/channels/${createdBody.channel.id}/share`,
      {
        method: 'POST',
        headers: ownerAuth,
        body: JSON.stringify({ email: 'reviewer@dsn.com' }),
      },
    );

    const draftResponse = await fetch(
      `${base}/diwan/api/code/sessions/${createdBody.session.id}/pair-prompts`,
      {
        method: 'POST',
        headers: ownerAuth,
        body: JSON.stringify({ initialText: 'ship this exact prompt' }),
      },
    );
    expect(draftResponse.status).toBe(201);
    const draftBody = await draftResponse.json();

    const ready = await fetch(
      `${base}/diwan/api/code/sessions/${createdBody.session.id}/pair-prompts/${draftBody.draft.id}/ready`,
      { method: 'POST', headers: ownerAuth },
    );
    expect(ready.status).toBe(200);

    const ownerApproval = await fetch(
      `${base}/diwan/api/code/sessions/${createdBody.session.id}/pair-prompts/${draftBody.draft.id}/approve`,
      { method: 'POST', headers: ownerAuth },
    );
    expect(ownerApproval.status).toBe(400);

    const reviewerApproval = await fetch(
      `${base}/diwan/api/code/sessions/${createdBody.session.id}/pair-prompts/${draftBody.draft.id}/approve`,
      { method: 'POST', headers: reviewerAuth },
    );
    expect(reviewerApproval.status).toBe(409);
    const approvalBody = await reviewerApproval.json();
    expect(approvalBody.draft.status).toBe('failed');
    expect(approvalBody.draft.failureCode).toBe('missing_opencode_session_id');
  });

  it('sends an approved pair prompt to the stored dyson-opencode session', async () => {
    const dyson = await fakeDyson((req, res) => {
      if (req.url === '/api/session/ses_dyson/prompt_async') {
        res.statusCode = 204;
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const sessions = new SessionStore(config.DIWAN_DATA_DIR);
    const chat = new ChatStore(config);
    const owner = authUser('owner@dsn.com');
    const session = codeSession({
      id: 'session-with-opencode-id',
      openCodeSessionId: 'ses_dyson',
      port: dyson.port,
      urlPath: '/diwan/code/session/session-with-opencode-id/',
    });
    sessions.set(session.id, session);
    const channel = chat.ensureSessionChannel(session, owner);
    chat.shareChannel(channel.id, 'reviewer@dsn.com', owner);

    const app = createApp(config, sessions, chat);
    const listener = app.listen(0);
    server = listener;
    const address = listener.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected TCP listener');
    const base = `http://127.0.0.1:${address.port}`;
    const ownerAuth = {
      Authorization: 'Dev owner@dsn.com',
      'Content-Type': 'application/json',
    };
    const reviewerAuth = {
      Authorization: 'Dev reviewer@dsn.com',
      'Content-Type': 'application/json',
    };

    const created = await fetch(
      `${base}/diwan/api/code/sessions/${session.id}/pair-prompts`,
      {
        method: 'POST',
        headers: ownerAuth,
        body: JSON.stringify({ initialText: 'approved exact prompt' }),
      },
    );
    const createdBody = await created.json();

    await fetch(
      `${base}/diwan/api/code/sessions/${session.id}/pair-prompts/${createdBody.draft.id}/ready`,
      { method: 'POST', headers: ownerAuth },
    );
    const approved = await fetch(
      `${base}/diwan/api/code/sessions/${session.id}/pair-prompts/${createdBody.draft.id}/approve`,
      { method: 'POST', headers: reviewerAuth },
    );

    expect(approved.status).toBe(200);
    const approvedBody = await approved.json();
    expect(approvedBody.draft.status).toBe('sent');
    expect(dyson.requests.map(request => request.url)).toContain(
      '/api/session/ses_dyson/prompt_async',
    );
    expect(JSON.parse(dyson.requests[0].body)).toEqual({
      parts: [{ type: 'text', text: 'approved exact prompt' }],
    });
  });
});
