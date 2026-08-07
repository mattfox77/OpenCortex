import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http, { createServer, type Server } from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/http/app.js';
import type { AppConfig } from '../src/config/config.js';
import {
  mintInternalToken,
  verifyInternalToken,
} from '../src/auth/internalToken.js';
import { SessionStore } from '../src/code/sessionStore.js';
import { ChatStore } from '../src/chat/chatStore.js';
import type {
  CaptureMemoryEntryInput,
  MemoryEntry,
  MemoryStore,
  ReviewMemoryEntryInput,
  SearchMemoryEntriesInput,
} from '../src/memory/memoryStore.js';
import type {
  ListWorkflowProjectionsInput,
  WorkflowProjection,
  WorkflowProjectionStore,
} from '../src/workflows/workflowProjectionStore.js';
import type { AuthenticatedUser } from '../src/auth/types.js';
import type { CodeSession } from '../src/code/sessionLauncher.js';
import type {
  PairPromptWorkflowStarter,
  PairPromptResponseSignaler,
  ReviewWorkflowStarter,
  WorkbenchSessionWorkflowArchiver,
  WorkbenchSessionWorkflowIssueAttacher,
  WorkbenchSessionWorkflowPairPromptSender,
  WorkbenchSessionWorkflowStarter,
} from '../src/http/routes.js';

let server: Server | undefined;
const backendListeners: net.Server[] = [];

function testConfig(): AppConfig {
  return {
    NODE_ENV: 'test',
    PORT: 0,
    OPENCORTEX_PUBLIC_BASE_URL: 'https://runtime.example.com/diwan/',
    OPENCORTEX_BASE_PATH: '/diwan',
    OPENCORTEX_DATA_DIR: mkdtempSync(join(tmpdir(), 'diwan-test-')),
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
    DIWAN_ALLOWED_EMAIL_DOMAIN: 'acme.test',
    OPENCORTEX_ALLOWED_EMAIL_DOMAINS: ['acme.test'],
    OPENCORTEX_SUPER_ADMIN_EMAILS: ['mfox@acme.test'],
    OPENCORTEX_INTERNAL_TOKEN_SECRET: 'test-internal-token-secret-32-bytes',
    OPENCORTEX_MEMORY_DATABASE_URL: '',
    OPENCORTEX_LINUX_USER_PREFIX: '',
    OPENCORTEX_WORKSPACE_ROOT: '/srv/opencortex/workspaces',
    OPENCORTEX_EXEC_MODE: 'dry-run',
    OPENCORTEX_WORKBENCH_PORT_BASE: 4100,
    OPENCORTEX_WORKBENCH_BIN: '/usr/local/bin/opencode',
    OPENCORTEX_WORKBENCH_SESSION_MODE: 'local',
    OPENCORTEX_WORKBENCH_SESSION_TASK_QUEUE: 'cortex-tasks',
    OPENCORTEX_WORKBENCH_SESSION_RUNTIME_BASE_URL: 'http://127.0.0.1:8080/api',
    OPENCORTEX_WORKBENCH_SESSION_MONITOR_INTERVAL: '30 seconds',
    OPENCORTEX_WORKBENCH_SESSION_MAX_PROBES: 0,
    OPENCORTEX_REVIEW_MODE: 'local',
    OPENCORTEX_REVIEW_TASK_QUEUE: 'cortex-tasks',
    OPENCORTEX_PAIR_PROMPT_MODE: 'local',
    OPENCORTEX_PAIR_PROMPT_TASK_QUEUE: 'cortex-tasks',
    OPENCORTEX_PAIR_PROMPT_RUNTIME_BASE_URL: 'http://127.0.0.1:8080/api',
    OPENCORTEX_PROVISION_USER_MODE: 'local',
    OPENCORTEX_PROVISIONING_TASK_QUEUE: 'cortex-tasks',
    OPENCORTEX_PROVISIONING_REQUIRED_TOOLS: ['node', 'npm', 'git', 'opencode', 'cortex'],
    OPENCORTEX_PROVISION_USER_SCRIPT: '/opt/opencortex/scripts/provision-opencortex-user.sh',
    OPENCORTEX_JIRA_BASE_URL: 'https://jira.example.test',
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

function startAppWithMemory(config: AppConfig, memory: MemoryStore) {
  const app = createApp(
    config,
    undefined,
    undefined,
    undefined,
    undefined,
    memory,
  );
  const listener = app.listen(0);
  const address = listener.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected TCP listener');
  const base = `http://127.0.0.1:${address.port}`;
  return { listener, base };
}

function startAppWithMemoryReviewWorkflow(
  config: AppConfig,
  memory: MemoryStore,
  reviewWorkflowStarter: ReviewWorkflowStarter,
) {
  const app = createApp(
    config,
    undefined,
    undefined,
    undefined,
    undefined,
    memory,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    reviewWorkflowStarter,
  );
  const listener = app.listen(0);
  const address = listener.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected TCP listener');
  const base = `http://127.0.0.1:${address.port}`;
  return { listener, base };
}

function startAppWithWorkflowProjections(
  config: AppConfig,
  workflowProjections: WorkflowProjectionStore,
  workbenchSessionWorkflowStarter?: WorkbenchSessionWorkflowStarter,
  workbenchSessionWorkflowArchiver?: WorkbenchSessionWorkflowArchiver,
) {
  const app = createApp(
    config,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    workflowProjections,
    workbenchSessionWorkflowStarter,
    workbenchSessionWorkflowArchiver,
  );
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
    ownerEmail: 'owner@acme.test',
    linuxUser: 'owner',
    workspaceDir: '/home/owner/repos',
    port: 4100,
    urlPath: '/diwan/code/session/live/',
    command: ['opencode', 'web'],
    mode: 'sudo',
    ...overrides,
  };
}

function workflowProjection(
  overrides: Partial<WorkflowProjection>,
): WorkflowProjection {
  return {
    workflowId: 'workflow-1',
    runId: 'run-1',
    workflowType: 'MemoryIngestWorkflow',
    status: 'completed',
    ownerId: 'owner@acme.test',
    project: 'runtime',
    sourceSystem: 'opencode',
    sourceSessionId: 'session-1',
    artifactId: '00000000-0000-0000-0000-000000000001',
    entryIds: ['00000000-0000-0000-0000-000000000002'],
    summary: 'Ingested memory',
    data: {},
    completedAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function fakeOpenCode(
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

class FakeMemoryStore implements MemoryStore {
  readonly captures: CaptureMemoryEntryInput[] = [];
  readonly searches: SearchMemoryEntriesInput[] = [];
  readonly reviews: ReviewMemoryEntryInput[] = [];
  private readonly entries: MemoryEntry[] = [];

  async captureEntry(input: CaptureMemoryEntryInput): Promise<MemoryEntry> {
    this.captures.push(input);
    const entry: MemoryEntry = {
      id: `entry-${this.entries.length + 1}`,
      createdAt: new Date().toISOString(),
      title: input.title,
      content: input.content,
      kind: input.kind,
      scope: input.scope,
      project: input.project,
      repo: input.repo,
      sourceSystem: input.sourceSystem,
      sourceSessionId: input.sourceSessionId,
      toolName: input.toolName,
      ownerId: input.ownerId,
      author: input.author,
      review: input.author === 'agent' ? 'pending' : 'approved',
      tags: input.tags,
      identitySubject: input.identitySubject,
    };
    this.entries.push(entry);
    return entry;
  }

  async searchEntries(input: SearchMemoryEntriesInput): Promise<MemoryEntry[]> {
    this.searches.push(input);
    return this.entries.filter(entry =>
      (entry.scope === 'global' ||
        entry.scope === 'team' ||
        (entry.scope === 'personal' &&
          (entry.identitySubject === input.identitySubject ||
            (!entry.identitySubject && entry.ownerId === input.ownerId)))) &&
      (input.query ? entry.content.includes(input.query) : true),
    );
  }

  async reviewEntry(input: ReviewMemoryEntryInput): Promise<MemoryEntry | undefined> {
    this.reviews.push(input);
    const entry = this.entries.find(candidate =>
      candidate.id === input.entryId &&
      candidate.ownerId === input.ownerId &&
      (candidate.scope === 'team' ||
        candidate.scope === 'global' ||
        candidate.identitySubject === input.identitySubject ||
        !candidate.identitySubject),
    );
    if (!entry) {
      return undefined;
    }
    entry.review = input.review;
    return entry;
  }
}

class FakeWorkflowProjectionStore implements WorkflowProjectionStore {
  readonly lists: ListWorkflowProjectionsInput[] = [];

  constructor(private readonly workflows: WorkflowProjection[]) {}

  async list(input: ListWorkflowProjectionsInput): Promise<WorkflowProjection[]> {
    this.lists.push(input);
    return this.workflows.filter(workflow =>
      (input.isSuperAdmin || workflow.ownerId === input.ownerId) &&
      (!input.workflowType || workflow.workflowType === input.workflowType) &&
      (!input.status || workflow.status === input.status) &&
      (!input.project || workflow.project === input.project) &&
      (!input.sourceSystem || workflow.sourceSystem === input.sourceSystem) &&
      (!input.sourceSessionId || workflow.sourceSessionId === input.sourceSessionId),
    ).slice(0, input.limit);
  }

  async get(
    workflowId: string,
    input: { ownerId: string; isSuperAdmin: boolean },
  ): Promise<WorkflowProjection | undefined> {
    return this.workflows.find(workflow =>
      workflow.workflowId === workflowId &&
      (input.isSuperAdmin || workflow.ownerId === input.ownerId),
    );
  }

  async metrics() {
    const byStatus: Record<string, number> = {};
    const byType: Record<string, number> = {};
    for (const workflow of this.workflows) {
      byStatus[workflow.status] = (byStatus[workflow.status] ?? 0) + 1;
      byType[workflow.workflowType] = (byType[workflow.workflowType] ?? 0) + 1;
    }
    return { byStatus, byType, oldestRunningAgeSeconds: 120 };
  }
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
    expect(html).toContain('<h2>Workbench</h2>');
    expect(html).toContain('id="observability-panel"');
    expect(html).not.toContain('<h2>OpenCode</h2>');
  });

  it('serves the TeamChat shell for standalone OpenCortex Workbench session tabs', async () => {
    const response = await request('/diwan/code/sessions/live');

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<base href="/diwan/" />');
    expect(html).toContain('<h2 id="channel-title">TeamChat</h2>');
    expect(html).toContain('<h2>Workbench</h2>');
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
      redirectUri: 'https://runtime.example.com/diwan/auth/callback',
      logoutUrl: 'https://runtime.example.com/diwan/',
      basePath: '/diwan',
      scope: 'openid email profile',
    });
  });

  it('exposes runtime metrics for collector scraping', async () => {
    const config = testConfig();
    const sessions = new SessionStore(config.OPENCORTEX_DATA_DIR);
    sessions.set('live', codeSession({ id: 'live' }));
    const workflows = new FakeWorkflowProjectionStore([
      workflowProjection({
        workflowId: 'running-1',
        status: 'running',
        workflowType: 'WorkbenchSessionWorkflow',
      }),
    ]);
    const app = createApp(
      config,
      sessions,
      undefined,
      undefined,
      undefined,
      undefined,
      workflows,
    );
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP listener');
    }
    const base = `http://127.0.0.1:${address.port}`;

    await fetch(`${base}/diwan/api/health`);
    const metrics = await fetch(`${base}/metrics`);

    expect(metrics.status).toBe(200);
    expect(metrics.headers.get('content-type')).toContain('text/plain');
    const body = await metrics.text();
    expect(body).toContain('opencortex_runtime_up 1');
    expect(body).toContain('opencortex_runtime_sessions_active 1');
    expect(body).toContain(
      'opencortex_runtime_workflows{status="running",workflow_type=""} 1',
    );
    expect(body).toContain(
      'opencortex_runtime_workflows{status="",workflow_type="WorkbenchSessionWorkflow"} 1',
    );
    expect(body).toContain('opencortex_runtime_workflow_oldest_running_age_seconds 120');
    expect(body).toContain('opencortex_runtime_db_query_duration_seconds');
    expect(body).toContain('opencortex_runtime_http_requests_total');
    expect(body).toContain('status_code="200"');
    expect(body).not.toContain('route="/metrics"');
  });

  it('accepts legacy auth cookies during the OpenCortex cookie rename window', async () => {
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const { listener, base } = startApp(config);
    server = listener;

    const response = await fetch(`${base}/diwan/api/me`, {
      headers: {
        Cookie: `diwan.idToken=${encodeURIComponent('Dev owner@acme.test')}`,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      user: { email: 'owner@acme.test' },
    });
  });

  it('exchanges OIDC auth codes with the configured token endpoint', async () => {
    const tokenBackend = await fakeOpenCode((_req, res) => {
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
      'https://runtime.example.com/diwan/auth/callback',
    );
    expect(form.get('code')).toBe('auth-code');
    expect(form.get('code_verifier')).toBe('pkce-verifier');
  });

  it('mints scoped internal tokens for authenticated users', async () => {
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const { listener, base } = startApp(config);
    server = listener;

    const response = await fetch(`${base}/diwan/api/auth/internal-token`, {
      method: 'POST',
      headers: {
        Authorization: 'Dev owner@acme.test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        scopes: ['memory:read', 'memory:write'],
        ttlSeconds: 60,
      }),
    });

    expect(response.status).toBe(201);
    const payload = await response.json() as {
      token: string;
      tokenType: string;
      scopes: string[];
      expiresAt: string;
    };
    expect(payload.tokenType).toBe('Bearer');
    expect(payload.scopes).toEqual(['memory:read', 'memory:write']);
    expect(new Date(payload.expiresAt).getTime()).toBeGreaterThan(Date.now());
    await expect(
      verifyInternalToken(
        payload.token,
        config.OPENCORTEX_INTERNAL_TOKEN_SECRET,
        ['memory:write'],
      ),
    ).resolves.toMatchObject({
      subject: 'dev:owner@acme.test',
      ownerEmail: 'owner@acme.test',
      linuxUser: 'owner',
      scopes: ['memory:read', 'memory:write'],
    });
  });

  it('captures and searches memory through scoped internal tokens', async () => {
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const memory = new FakeMemoryStore();
    const { listener, base } = startAppWithMemory(config, memory);
    server = listener;
    const minted = await mintInternalToken({
      user: authUser('owner@acme.test'),
      scopes: ['memory:read', 'memory:write'],
      secret: config.OPENCORTEX_INTERNAL_TOKEN_SECRET,
    });

    const capture = await fetch(`${base}/diwan/api/memory/entries`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${minted.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: 'Captured through the OpenCortex memory API',
        title: 'Runtime memory capture',
        scope: 'personal',
        kind: 'finding',
        project: 'runtime',
        sourceSystem: 'opencortex-session',
        sourceSessionId: 'session-1',
        toolName: 'opencode',
        tags: ['api'],
      }),
    });

    expect(capture.status).toBe(201);
    await expect(capture.json()).resolves.toMatchObject({
      entry: {
        title: 'Runtime memory capture',
        ownerId: 'owner@acme.test',
        identitySubject: 'dev:owner@acme.test',
      },
    });
    expect(memory.captures[0]).toMatchObject({
      ownerId: 'owner@acme.test',
      identitySubject: 'dev:owner@acme.test',
      scope: 'personal',
    });

    const search = await fetch(
      `${base}/diwan/api/memory/entries?q=OpenCortex&limit=5`,
      { headers: { Authorization: `Bearer ${minted.token}` } },
    );

    expect(search.status).toBe(200);
    await expect(search.json()).resolves.toMatchObject({
      entries: [{ title: 'Runtime memory capture' }],
    });
    expect(memory.searches[0]).toMatchObject({
      ownerId: 'owner@acme.test',
      identitySubject: 'dev:owner@acme.test',
      query: 'OpenCortex',
      limit: 5,
    });
  });

  it('rejects memory writes without the memory write scope', async () => {
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const memory = new FakeMemoryStore();
    const { listener, base } = startAppWithMemory(config, memory);
    server = listener;
    const minted = await mintInternalToken({
      user: authUser('owner@acme.test'),
      scopes: ['memory:read'],
      secret: config.OPENCORTEX_INTERNAL_TOKEN_SECRET,
    });

    const response = await fetch(`${base}/diwan/api/memory/entries`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${minted.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'should not write' }),
    });

    expect(response.status).toBe(403);
    expect(memory.captures).toHaveLength(0);
  });

  it('reviews memory entries through internal-token identity', async () => {
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const memory = new FakeMemoryStore();
    const { listener, base } = startAppWithMemory(config, memory);
    server = listener;
    const minted = await mintInternalToken({
      user: authUser('owner@acme.test'),
      scopes: ['memory:read', 'memory:write'],
      secret: config.OPENCORTEX_INTERNAL_TOKEN_SECRET,
    });

    const capture = await fetch(`${base}/diwan/api/memory/entries`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${minted.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: 'agent decision awaiting review',
        author: 'agent',
      }),
    });
    expect(capture.status).toBe(201);

    const response = await fetch(`${base}/diwan/api/memory/entries/entry-1/review`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${minted.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        review: 'approved',
        notes: 'looks correct',
      }),
    });

    expect(response.status).toBe(200);
    const payload = await response.json() as { entry: MemoryEntry };
    expect(payload.entry.review).toBe('approved');
    expect(memory.reviews).toEqual([
      expect.objectContaining({
        entryId: 'entry-1',
        ownerId: 'owner@acme.test',
        identitySubject: 'dev:owner@acme.test',
        review: 'approved',
        reviewerEmail: 'owner@acme.test',
        notes: 'looks correct',
      }),
    ]);
  });

  it('starts ReviewWorkflow for memory review decisions in workflow mode', async () => {
    const config: AppConfig = {
      ...testConfig(),
      NODE_ENV: 'development',
      OPENCORTEX_REVIEW_MODE: 'workflow',
    };
    const memory = new FakeMemoryStore();
    const starts: Parameters<ReviewWorkflowStarter>[1][] = [];
    const reviewWorkflowStarter: ReviewWorkflowStarter = async (_config, params) => {
      starts.push(params);
      return {
        workflowId: 'review-entry-1',
        runId: 'run-review-1',
        signal: 'approve',
      };
    };
    const { listener, base } = startAppWithMemoryReviewWorkflow(
      config,
      memory,
      reviewWorkflowStarter,
    );
    server = listener;
    const minted = await mintInternalToken({
      user: authUser('owner@acme.test'),
      scopes: ['memory:write'],
      secret: config.OPENCORTEX_INTERNAL_TOKEN_SECRET,
    });

    const response = await fetch(`${base}/diwan/api/memory/entries/entry-1/review`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${minted.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        review: 'approved',
        notes: 'reviewed by workflow',
      }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      workflow: {
        workflowId: 'review-entry-1',
        runId: 'run-review-1',
        signal: 'approve',
      },
    });
    expect(starts).toEqual([
      {
        entryId: 'entry-1',
        ownerId: 'owner@acme.test',
        review: 'approved',
        reviewerEmail: 'owner@acme.test',
        notes: 'reviewed by workflow',
      },
    ]);
    expect(memory.reviews).toHaveLength(0);
  });

  it('isolates personal memory by internal-token identity subject', async () => {
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const memory = new FakeMemoryStore();
    const { listener, base } = startAppWithMemory(config, memory);
    server = listener;
    const owner = await mintInternalToken({
      user: authUser('owner@acme.test'),
      scopes: ['memory:read', 'memory:write'],
      secret: config.OPENCORTEX_INTERNAL_TOKEN_SECRET,
    });
    const teammate = await mintInternalToken({
      user: authUser('teammate@acme.test'),
      scopes: ['memory:read', 'memory:write'],
      secret: config.OPENCORTEX_INTERNAL_TOKEN_SECRET,
    });

    for (const [token, content, scope] of [
      [owner.token, 'OpenCortex owner personal note', 'personal'],
      [teammate.token, 'OpenCortex teammate personal note', 'personal'],
      [teammate.token, 'OpenCortex team note', 'team'],
    ]) {
      const response = await fetch(`${base}/diwan/api/memory/entries`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content, scope }),
      });
      expect(response.status).toBe(201);
    }

    const response = await fetch(
      `${base}/diwan/api/memory/entries?q=OpenCortex&limit=10`,
      { headers: { Authorization: `Bearer ${owner.token}` } },
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as { entries: MemoryEntry[] };
    expect(payload.entries.map(entry => entry.content)).toEqual([
      'OpenCortex owner personal note',
      'OpenCortex team note',
    ]);
    expect(memory.searches.at(-1)).toMatchObject({
      ownerId: 'owner@acme.test',
      identitySubject: 'dev:owner@acme.test',
    });
  });

  it('lists workflow projections through authenticated runtime API', async () => {
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const workflowStore = new FakeWorkflowProjectionStore([
      workflowProjection({
        workflowId: 'workflow-1',
        ownerId: 'owner@acme.test',
        project: 'runtime',
      }),
      workflowProjection({
        workflowId: 'workflow-2',
        ownerId: 'other@acme.test',
        project: 'runtime',
      }),
    ]);
    const { listener, base } = startAppWithWorkflowProjections(config, workflowStore);
    server = listener;

    const response = await fetch(
      `${base}/diwan/api/workflows?workflowType=MemoryIngestWorkflow&status=completed&project=runtime&limit=5`,
      { headers: { Authorization: 'Dev owner@acme.test' } },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.workflows).toMatchObject([
      {
        workflowId: 'workflow-1',
        ownerId: 'owner@acme.test',
        workflowType: 'MemoryIngestWorkflow',
        status: 'completed',
      },
    ]);
    expect(workflowStore.lists[0]).toMatchObject({
      ownerId: 'owner@acme.test',
      isSuperAdmin: false,
      workflowType: 'MemoryIngestWorkflow',
      status: 'completed',
      project: 'runtime',
      limit: 5,
    });
  });

  it('shows owned workflow projections and hides other users projections', async () => {
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const workflowStore = new FakeWorkflowProjectionStore([
      workflowProjection({
        workflowId: 'workflow-1',
        ownerId: 'owner@acme.test',
      }),
    ]);
    const { listener, base } = startAppWithWorkflowProjections(config, workflowStore);
    server = listener;

    const visible = await fetch(`${base}/diwan/api/workflows/workflow-1`, {
      headers: { Authorization: 'Dev owner@acme.test' },
    });
    const hidden = await fetch(`${base}/diwan/api/workflows/workflow-1`, {
      headers: { Authorization: 'Dev other@acme.test' },
    });

    expect(visible.status).toBe(200);
    const visibleBody = await visible.json();
    expect(visibleBody.workflow).toMatchObject({
      workflowId: 'workflow-1',
      ownerId: 'owner@acme.test',
    });
    expect(hidden.status).toBe(404);
  });

  it('summarizes observable workflow and session state without leaking other users', async () => {
    const config: AppConfig = {
      ...testConfig(),
      NODE_ENV: 'development',
      OPENCORTEX_WORKSPACE_ROOT: mkdtempSync(
        join(tmpdir(), 'opencortex-workspaces-test-'),
      ),
    };
    const sessions = new SessionStore(config.OPENCORTEX_DATA_DIR);
    sessions.set('owned', codeSession({
      id: 'owned',
      ownerEmail: 'owner@acme.test',
      mode: 'sudo',
    }));
    sessions.set('other', codeSession({
      id: 'other',
      ownerEmail: 'other@acme.test',
      linuxUser: 'other',
      mode: 'dry-run',
    }));
    const workflowStore = new FakeWorkflowProjectionStore([
      workflowProjection({
        workflowId: 'running-1',
        status: 'running',
        workflowType: 'WorkbenchSessionWorkflow',
        ownerId: 'owner@acme.test',
        startedAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      }),
      workflowProjection({
        workflowId: 'failed-1',
        status: 'failed',
        workflowType: 'MemoryIngestWorkflow',
        ownerId: 'owner@acme.test',
        summary: 'Memory ingest failed',
        data: { traceId: 'trace-1' },
      }),
      workflowProjection({
        workflowId: 'hidden-failed',
        status: 'failed',
        ownerId: 'other@acme.test',
      }),
    ]);
    const app = createApp(
      config,
      sessions,
      undefined,
      undefined,
      undefined,
      undefined,
      workflowStore,
    );
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP listener');
    }

    const response = await fetch(
      `http://127.0.0.1:${address.port}/diwan/api/observability/summary`,
      { headers: { Authorization: 'Dev owner@acme.test' } },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.summary.sessions).toMatchObject({
      active: 1,
      byMode: { sudo: 1 },
    });
    expect(body.summary.workflows).toMatchObject({
      recent: 2,
      running: 1,
      failed: 1,
      byStatus: { failed: 1, running: 1 },
      byType: { MemoryIngestWorkflow: 1, WorkbenchSessionWorkflow: 1 },
    });
    expect(body.summary.workflows.failedItems).toMatchObject([
      {
        workflowId: 'failed-1',
        summary: 'Memory ingest failed',
        traceId: 'trace-1',
      },
    ]);
    expect(body.summary.disk).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'runtime data',
          path: config.OPENCORTEX_DATA_DIR,
          available: true,
        }),
        expect.objectContaining({
          name: 'workspaces',
          path: config.OPENCORTEX_WORKSPACE_ROOT,
          available: true,
        }),
      ]),
    );
    expect(body.summary.disk[0].totalBytes).toBeGreaterThan(0);
    expect(body.summary.disk[0].usedPercent).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(body)).not.toContain('hidden-failed');
  });

  it('starts WorkbenchSessionWorkflow and returns its projection row in workflow mode', async () => {
    const config: AppConfig = {
      ...testConfig(),
      NODE_ENV: 'development',
      OPENCORTEX_WORKBENCH_SESSION_MODE: 'workflow',
    };
    const workflowStore = new FakeWorkflowProjectionStore([
      workflowProjection({
        workflowId: 'workbench-session-owner-1',
        runId: 'run-workbench-1',
        workflowType: 'WorkbenchSessionWorkflow',
        status: 'running',
        ownerId: 'owner@acme.test',
        sourceSystem: 'opencortex-runtime',
        sourceSessionId: 'session-owner',
        entryIds: [],
        summary: 'Workbench session session-owner running for owner@acme.test',
        data: {
          session: { id: 'session-owner' },
        },
      }),
    ]);
    const starts: Array<Pick<AuthenticatedUser, 'email' | 'linuxUser' | 'sub'>> = [];
    const starter: WorkbenchSessionWorkflowStarter = async (_config, user) => {
      starts.push(user);
      return {
        workflowId: 'workbench-session-owner-1',
        runId: 'run-workbench-1',
      };
    };
    const { listener, base } = startAppWithWorkflowProjections(
      config,
      workflowStore,
      starter,
    );
    server = listener;

    const response = await fetch(`${base}/diwan/api/code/sessions`, {
      method: 'POST',
      headers: { Authorization: 'Dev owner@acme.test' },
    });

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(starts).toHaveLength(1);
    expect(body.workflow).toEqual({
      workflowId: 'workbench-session-owner-1',
      runId: 'run-workbench-1',
    });
    expect(body.projection).toMatchObject({
      workflowId: 'workbench-session-owner-1',
      runId: 'run-workbench-1',
      workflowType: 'WorkbenchSessionWorkflow',
      status: 'running',
      ownerId: 'owner@acme.test',
      sourceSessionId: 'session-owner',
    });
  });

  it('signals WorkbenchSessionWorkflow archive instead of deleting directly in workflow mode', async () => {
    const config: AppConfig = {
      ...testConfig(),
      NODE_ENV: 'development',
      OPENCORTEX_WORKBENCH_SESSION_MODE: 'workflow',
    };
    const sessions = new SessionStore(config.OPENCORTEX_DATA_DIR);
    sessions.set('session-owner', codeSession({
      id: 'session-owner',
      ownerEmail: 'owner@acme.test',
      linuxUser: 'owner',
    }));
    const workflowStore = new FakeWorkflowProjectionStore([
      workflowProjection({
        workflowId: 'workbench-session-owner-1',
        runId: 'run-workbench-1',
        workflowType: 'WorkbenchSessionWorkflow',
        status: 'running',
        ownerId: 'owner@acme.test',
        sourceSystem: 'opencortex-runtime',
        sourceSessionId: 'session-owner',
        entryIds: [],
      }),
    ]);
    const archiveSignals: Array<{ workflowId: string; reason?: string }> = [];
    const archiver: WorkbenchSessionWorkflowArchiver = async (
      _config,
      workflowId,
      reason,
    ) => {
      archiveSignals.push({ workflowId, reason });
      return {
        workflowId,
        signal: 'archiveSession',
      };
    };
    const app = createApp(
      config,
      sessions,
      undefined,
      undefined,
      undefined,
      undefined,
      workflowStore,
      undefined,
      archiver,
    );
    const listener = app.listen(0);
    server = listener;
    const address = listener.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected TCP listener');
    const base = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${base}/diwan/api/code/sessions/session-owner`, {
      method: 'DELETE',
      headers: { Authorization: 'Dev owner@acme.test' },
    });

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(archiveSignals).toEqual([
      {
        workflowId: 'workbench-session-owner-1',
        reason: 'Archive requested for session session-owner',
      },
    ]);
    expect(sessions.get('session-owner')).toBeDefined();
    expect(body.workflow).toEqual({
      workflowId: 'workbench-session-owner-1',
      signal: 'archiveSession',
    });
    expect(body.projection).toMatchObject({
      workflowId: 'workbench-session-owner-1',
      sourceSessionId: 'session-owner',
      status: 'running',
    });
  });

  it('requires auth to list code sessions', async () => {
    const response = await request('/diwan/api/code/sessions');
    expect(response.status).toBe(401);
  });

  it('lets WorkbenchSessionWorkflow use the internal runtime session API', async () => {
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const { listener, base } = startApp(config);
    server = listener;
    const minted = await mintInternalToken({
      user: {
        sub: 'workflow:workbench-session',
        email: 'owner@acme.test',
        groups: [],
        linuxUser: 'owner',
      },
      scopes: ['session'],
      secret: config.OPENCORTEX_INTERNAL_TOKEN_SECRET,
      ttlSeconds: 60,
    });
    const auth = { Authorization: `Bearer ${minted.token}` };

    const created = await fetch(`${base}/diwan/api/runtime/code/sessions`, {
      method: 'POST',
      headers: auth,
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.session.ownerEmail).toBe('owner@acme.test');

    const listed = await fetch(`${base}/diwan/api/runtime/code/sessions`, {
      headers: auth,
    });
    expect(listed.status).toBe(200);
    const listedBody = await listed.json();
    expect(listedBody.sessions.map((item: { id: string }) => item.id)).toEqual([
      createdBody.session.id,
    ]);

    const archived = await fetch(
      `${base}/diwan/api/runtime/code/sessions/${createdBody.session.id}`,
      {
        method: 'DELETE',
        headers: auth,
      },
    );
    expect(archived.status).toBe(200);
  });

  it('restores a previously created session on a later GET (same server)', async () => {
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const { listener, base } = startApp(config);
    server = listener;

    const devAuth = { Authorization: 'Dev tester@acme.test' };

    const created = await fetch(`${base}/diwan/api/code/sessions`, {
      method: 'POST',
      headers: devAuth,
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.session.id).toBeTruthy();
    expect(createdBody.session.ownerEmail).toBe('tester@acme.test');

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

    const devAuth = { Authorization: 'Dev tester@acme.test' };

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
    const initialSessions = new SessionStore(config.OPENCORTEX_DATA_DIR);
    const initialChat = new ChatStore(config);
    const channel = initialChat.ensureSessionChannel(
      session,
      authUser('owner@acme.test'),
    );
    initialSessions.set(session.id, session);

    const restartedSessions = new SessionStore(config.OPENCORTEX_DATA_DIR);
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
      { headers: { Authorization: 'Dev owner@acme.test' } },
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
    const sessions = new SessionStore(config.OPENCORTEX_DATA_DIR);
    const chat = new ChatStore(config);
    const channel = chat.ensureSessionChannel(
      session,
      authUser('owner@acme.test'),
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
      { headers: { Authorization: 'Dev owner@acme.test' } },
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
      chat.getChannelForUser(channel.id, authUser('owner@acme.test'))?.archivedAt,
    ).toBeUndefined();
  });

  it("does not leak another user's sessions", async () => {
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const { listener, base } = startApp(config);
    server = listener;

    await fetch(`${base}/diwan/api/code/sessions`, {
      method: 'POST',
      headers: { Authorization: 'Dev owner@acme.test' },
    });

    const other = await fetch(`${base}/diwan/api/code/sessions`, {
      headers: { Authorization: 'Dev someone-else@acme.test' },
    });
    expect(other.status).toBe(200);
    const body = await other.json();
    expect(body.sessions).toHaveLength(0);
  });

  it('archives owned code sessions and hides them from later lists', async () => {
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const { listener, base } = startApp(config);
    server = listener;
    const ownerAuth = { Authorization: 'Dev owner@acme.test' };
    const otherAuth = { Authorization: 'Dev other@acme.test' };

    const created = await fetch(`${base}/diwan/api/code/sessions`, {
      method: 'POST',
      headers: ownerAuth,
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();

    const denied = await fetch(
      `${base}/diwan/api/code/sessions/${createdBody.session.id}`,
      { method: 'DELETE', headers: otherAuth },
    );
    expect(denied.status).toBe(404);

    const archived = await fetch(
      `${base}/diwan/api/code/sessions/${createdBody.session.id}`,
      { method: 'DELETE', headers: ownerAuth },
    );
    expect(archived.status).toBe(200);
    const archivedBody = await archived.json();
    expect(archivedBody.session.id).toBe(createdBody.session.id);
    expect(archivedBody.channel.archivedAt).toBeTruthy();

    const listed = await fetch(`${base}/diwan/api/code/sessions`, {
      headers: ownerAuth,
    });
    const listedBody = await listed.json();
    expect(listedBody.sessions).toHaveLength(0);
  });

  it("lets super admins see everyone else's sessions and untagged activity", async () => {
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const { listener, base } = startApp(config);
    server = listener;

    const ownerAuth = { Authorization: 'Dev grathke@acme.test' };
    const superAdminAuth = { Authorization: 'Dev mfox@acme.test' };

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
        ownerEmail: 'grathke@acme.test',
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
        ownerEmail: 'grathke@acme.test',
      },
    ]);
  });

  it('creates private session channels and shares them with members', async () => {
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const { listener, base } = startApp(config);
    server = listener;

    const ownerAuth = {
      Authorization: 'Dev owner@acme.test',
      'Content-Type': 'application/json',
    };
    const otherAuth = { Authorization: 'Dev other@acme.test' };

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
        body: JSON.stringify({ email: 'other@acme.test' }),
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
          Authorization: 'Dev other@acme.test',
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
    const sessions = new SessionStore(config.OPENCORTEX_DATA_DIR);
    const chat = new ChatStore(config);
    const owner = authUser('owner@acme.test');
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
      { headers: { Authorization: 'Dev owner@acme.test' } },
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
    const slack = await fakeOpenCode((req, res) => {
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
      headers: { Authorization: 'Dev owner@acme.test' },
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

  it('updates session channel names from OpenCode session metadata', async () => {
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
    const sessions = new SessionStore(config.OPENCORTEX_DATA_DIR);
    const chat = new ChatStore(config);
    sessions.set(session.id, session);
    const channel = chat.ensureSessionChannel(
      session,
      authUser('owner@acme.test'),
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
      { headers: { Authorization: 'Dev owner@acme.test' } },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(
      body.channels.find((item: { id: string }) => item.id === channel.id).name,
    ).toBe('Greeting');
  });

  it('syncs TeamChat session channels from the OpenCode session inventory', async () => {
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
                  title: 'Pull payments-core',
                  project: { path: '/home/owner/repos/payments-core' },
                },
                {
                  id: 'ses_clone',
                  title: 'Clone ExampleOrg/payments-core',
                  cwd: '/home/owner/repos/payments-core',
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
    const sessions = new SessionStore(config.OPENCORTEX_DATA_DIR);
    const chat = new ChatStore(config);
    const owner = authUser('owner@acme.test');
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
      { headers: { Authorization: 'Dev owner@acme.test' } },
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
          name: 'Pull payments-core',
          openCodeSessionId: 'ses_pull',
          workspaceDir: '/home/owner/repos/payments-core',
        },
        {
          name: 'Clone ExampleOrg/payments-core',
          openCodeSessionId: 'ses_clone',
          workspaceDir: '/home/owner/repos/payments-core',
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

  it('tracks a selected OpenCortex Workbench thread from proxied navigation without changing the active thread', async () => {
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
    const sessions = new SessionStore(config.OPENCORTEX_DATA_DIR);
    const chat = new ChatStore(config);
    sessions.set(session.id, session);
    const channel = chat.ensureSessionChannel(
      session,
      authUser('owner@acme.test'),
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
      Cookie: `opencortex.idToken=${encodeURIComponent('Dev owner@acme.test')}`,
    };
    const projectPath = '/home/owner/repos/payments-core';
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
      headers: { Authorization: 'Dev owner@acme.test' },
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

  it('lists every live OpenCortex Workbench thread channel with a runnable workspace URL', async () => {
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
    const sessions = new SessionStore(config.OPENCORTEX_DATA_DIR);
    const chat = new ChatStore(config);
    const owner = authUser('owner@acme.test');
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
      { headers: { Authorization: 'Dev owner@acme.test' } },
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

  it('redirects raw OpenCortex Workbench thread URLs back into the managed session proxy', async () => {
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const sessions = new SessionStore(config.OPENCORTEX_DATA_DIR);
    const chat = new ChatStore(config);
    const owner = authUser('owner@acme.test');
    const workspaceDir = '/home/owner/repos/payments-core';
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
          Cookie: `opencortex.idToken=${encodeURIComponent('Dev owner@acme.test')}`,
        },
        redirect: 'manual',
      },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      `/diwan/code/session/live/${workspaceToken}/session/ses_existing`,
    );
  });

  it('opens different OpenCortex Workbench session links without changing the active thread globally', async () => {
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const backendPort = await listenOnHttpBackend((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html><head></head><body>${req.url}</body></html>`);
    });
    const sessions = new SessionStore(config.OPENCORTEX_DATA_DIR);
    const chat = new ChatStore(config);
    const owner = authUser('owner@acme.test');
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
      Cookie: `opencortex.idToken=${encodeURIComponent('Dev owner@acme.test')}`,
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
      Authorization: 'Dev owner@acme.test',
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
        body: JSON.stringify({ body: 'Starting OC-321 now' }),
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
      { kind: 'issue', targetKey: 'OC-321', source: 'chat-message' },
    ]);

    const searched = await fetch(
      `${base}/diwan/api/work-tracking/sessions?jiraKey=OC-321`,
      { headers: ownerAuth },
    );
    expect(searched.status).toBe(200);
    const searchedBody = await searched.json();
    expect(searchedBody.sessions).toHaveLength(1);
    expect(searchedBody.sessions[0].id).toBe(createdBody.session.id);

    const detail = await fetch(
      `${base}/diwan/api/work-tracking/jira-items/OC-321`,
      { headers: ownerAuth },
    );
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody).toMatchObject({
      key: 'OC-321',
      item: {
        key: 'OC-321',
        projectKey: 'OC',
      },
      sourceCounts: {
        'chat-message': 1,
      },
    });
    expect(detailBody.links).toHaveLength(1);
    expect(detailBody.sessions[0].id).toBe(createdBody.session.id);
    expect(detailBody.integrationFormat.descriptionSection).toContain(
      '## OpenCortex Integration',
    );
  });

  it('signals WorkbenchSessionWorkflow when an issue is attached in workflow mode', async () => {
    const config: AppConfig = {
      ...testConfig(),
      NODE_ENV: 'development',
      OPENCORTEX_WORKBENCH_SESSION_MODE: 'workflow',
    };
    const sessions = new SessionStore(config.OPENCORTEX_DATA_DIR);
    const chat = new ChatStore(config);
    const owner = authUser('owner@acme.test');
    const session = codeSession({
      id: 'session-owner',
      ownerEmail: owner.email,
      linuxUser: owner.linuxUser,
    });
    sessions.set(session.id, session);
    chat.ensureSessionChannel(session, owner);
    const workflowStore = new FakeWorkflowProjectionStore([
      workflowProjection({
        workflowId: 'workbench-session-owner-1',
        runId: 'run-workbench-1',
        workflowType: 'WorkbenchSessionWorkflow',
        status: 'running',
        ownerId: owner.email,
        sourceSystem: 'opencortex-runtime',
        sourceSessionId: session.id,
        entryIds: [],
      }),
    ]);
    const issueSignals: Array<{
      workflowId: string;
      params: { issueKey: string; url?: string };
    }> = [];
    const issueAttacher: WorkbenchSessionWorkflowIssueAttacher = async (
      _config,
      workflowId,
      params,
    ) => {
      issueSignals.push({ workflowId, params });
      return {
        workflowId,
        signal: 'attachIssue',
      };
    };
    const app = createApp(
      config,
      sessions,
      chat,
      undefined,
      undefined,
      undefined,
      workflowStore,
      undefined,
      undefined,
      issueAttacher,
    );
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected TCP listener');
    const base = `http://127.0.0.1:${address.port}`;

    const response = await fetch(
      `${base}/diwan/api/code/sessions/${session.id}/jira-links`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Dev owner@acme.test',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ reference: 'OC-456' }),
      },
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(issueSignals).toEqual([
      {
        workflowId: 'workbench-session-owner-1',
        params: { issueKey: 'OC-456' },
      },
    ]);
    expect(body.workflowSignals).toEqual([
      {
        workflowId: 'workbench-session-owner-1',
        signal: 'attachIssue',
      },
    ]);
  });

  it('lets shared session members manually tag teams and search by team', async () => {
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const { listener, base } = startApp(config);
    server = listener;

    const ownerAuth = {
      Authorization: 'Dev owner@acme.test',
      'Content-Type': 'application/json',
    };
    const memberAuth = {
      Authorization: 'Dev member@acme.test',
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
        body: JSON.stringify({ email: 'member@acme.test' }),
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
        createdByEmail: 'member@acme.test',
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
      Authorization: 'Dev owner@acme.test',
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
        Cookie: `opencortex.idToken=${encodeURIComponent('Dev unrelated@acme.test')}`,
      },
    });
    expect(unrelated.status).toBe(404);

    await fetch(
      `${base}/diwan/api/chat/channels/${createdBody.channel.id}/share`,
      {
        method: 'POST',
        headers: ownerAuth,
        body: JSON.stringify({ email: 'other@acme.test' }),
      },
    );

    const shared = await fetch(sessionPath, {
      headers: {
        Cookie: `opencortex.idToken=${encodeURIComponent('Dev other@acme.test')}`,
      },
    });
    // dry-run mode does not start an OpenCode backend, so an authorized proxy
    // request reaches the proxy and fails upstream instead of being hidden.
    expect(shared.status).toBe(502);
  });

  it('rebrands proxied OpenCode browser assets to OpenCortex Workbench', async () => {
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const backendPort = await listenOnHttpBackend((req, res) => {
      if (req.url === '/assets/app.js') {
        res.writeHead(200, {
          'content-type': 'application/javascript',
          etag: 'test-etag',
        });
        res.end(
          'document.title = "OpenCode"; const apiBase = location.hostname.includes("opencode.ai")?"http://localhost:4096":location.origin; const chunks = ["assets/lazy.js", "/assets/root.js"];',
        );
        return;
      }
      if (req.url === '/assets/app.css') {
        res.writeHead(200, {
          'content-type': 'text/css',
        });
        res.end('body { color: black; }');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        '<html><head><title>OpenCode</title><script type="module" src="/assets/app.js"></script><link rel="stylesheet" href="/assets/app.css"></head><body>OpenCode</body></html>',
      );
    });
    const session = codeSession({ id: 'live', port: backendPort });
    const sessions = new SessionStore(config.OPENCORTEX_DATA_DIR);
    const chat = new ChatStore(config);
    sessions.set(session.id, session);
    const channel = chat.ensureSessionChannel(
      session,
      authUser('owner@acme.test'),
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
      Cookie: `opencortex.idToken=${encodeURIComponent('Dev owner@acme.test')}`,
    };

    const html = await fetch(`${base}/diwan/code/session/live/`, {
      headers: cookie,
    });
    expect(html.status).toBe(200);
    expect(html.headers.get('etag')).toBeNull();
    const htmlBody = await html.text();
    expect(htmlBody).toContain('OpenCortex Workbench');
    expect(htmlBody).toContain('src="/diwan/code/session/live/assets/app.js"');
    expect(htmlBody).toContain('href="/diwan/code/session/live/assets/app.css"');
    expect(htmlBody).toContain('data-opencortex-session-addon');
    expect(htmlBody).toContain('data-channel-id="');
    expect(htmlBody).toContain('data-workbench-url="/diwan/code/sessions/live"');
    expect(htmlBody).toContain(
      'data-slack-url="https://workspace.example.com/archives/CSESSION"',
    );
    expect(htmlBody).toContain('/diwan/opencortex-session-addon.js');

    const js = await fetch(`${base}/diwan/code/session/live/assets/app.js`, {
      headers: cookie,
    });
    expect(js.status).toBe(200);
    expect(js.headers.get('etag')).toBeNull();
    await expect(js.text()).resolves.toBe(
      'document.title = "OpenCortex Workbench"; const apiBase = location.hostname.includes("opencode.ai")?"http://localhost:4096":document.baseURI.replace(/\\/$/,""); const chunks = ["/diwan/code/session/live/assets/lazy.js", "/diwan/code/session/live/assets/root.js"];',
    );
  });

  it('runs pair prompt review lifecycle for shared session members', async () => {
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const { listener, base } = startApp(config);
    server = listener;

    const ownerAuth = {
      Authorization: 'Dev owner@acme.test',
      'Content-Type': 'application/json',
    };
    const reviewerAuth = {
      Authorization: 'Dev reviewer@acme.test',
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
        body: JSON.stringify({ email: 'reviewer@acme.test' }),
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

  it('starts PairPromptWorkflow for approvals in pair-prompt workflow mode', async () => {
    const config: AppConfig = {
      ...testConfig(),
      NODE_ENV: 'development',
      OPENCORTEX_PAIR_PROMPT_MODE: 'workflow',
    };
    const sessions = new SessionStore(config.OPENCORTEX_DATA_DIR);
    const chat = new ChatStore(config);
    const owner = authUser('owner@acme.test');
    const session = codeSession({
      id: 'session-with-opencode-id',
      openCodeSessionId: 'ses_opencode',
    });
    sessions.set(session.id, session);
    const channel = chat.ensureSessionChannel(session, owner);
    chat.shareChannel(channel.id, 'reviewer@acme.test', owner);
    const starts: Parameters<PairPromptWorkflowStarter>[2][] = [];
    const pairPromptWorkflowStarter: PairPromptWorkflowStarter = async (
      _config,
      _user,
      params,
    ) => {
      starts.push(params);
      return {
        workflowId: 'pair-prompt-workflow-1',
        runId: 'run-pair-prompt-1',
        signal: 'approve',
      };
    };
    const app = createApp(
      config,
      sessions,
      chat,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      pairPromptWorkflowStarter,
    );
    const listener = app.listen(0);
    server = listener;
    const address = listener.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected TCP listener');
    const base = `http://127.0.0.1:${address.port}`;
    const ownerAuth = {
      Authorization: 'Dev owner@acme.test',
      'Content-Type': 'application/json',
    };
    const reviewerAuth = {
      Authorization: 'Dev reviewer@acme.test',
      'Content-Type': 'application/json',
    };

    const created = await fetch(
      `${base}/diwan/api/code/sessions/${session.id}/pair-prompts`,
      {
        method: 'POST',
        headers: ownerAuth,
        body: JSON.stringify({ initialText: 'workflow approved prompt' }),
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

    expect(approved.status).toBe(202);
    const approvedBody = await approved.json();
    expect(approvedBody.draft.status).toBe('ready');
    expect(approvedBody.workflow).toEqual({
      workflowId: 'pair-prompt-workflow-1',
      runId: 'run-pair-prompt-1',
      signal: 'approve',
    });
    expect(starts).toEqual([
      {
        sessionId: session.id,
        draftId: createdBody.draft.id,
        channelId: channel.id,
        ownerId: 'owner@acme.test',
        decision: 'approve',
      },
    ]);
  });

  it('captures pair prompt responses and signals the active workflow', async () => {
    const config: AppConfig = {
      ...testConfig(),
      NODE_ENV: 'development',
      OPENCORTEX_PAIR_PROMPT_MODE: 'workflow',
    };
    const sessions = new SessionStore(config.OPENCORTEX_DATA_DIR);
    const chat = new ChatStore(config);
    const owner = authUser('owner@acme.test');
    const session = codeSession({
      id: 'session-with-opencode-id',
      openCodeSessionId: 'ses_opencode',
    });
    sessions.set(session.id, session);
    const channel = chat.ensureSessionChannel(session, owner);
    chat.shareChannel(channel.id, 'reviewer@acme.test', owner);
    const pairPromptWorkflowStarter: PairPromptWorkflowStarter = async () => ({
      workflowId: 'pair-prompt-workflow-1',
      runId: 'run-pair-prompt-1',
      signal: 'approve',
    });
    const responseSignals: Array<{
      workflowId: string;
      params: Parameters<PairPromptResponseSignaler>[2];
    }> = [];
    const pairPromptResponseSignaler: PairPromptResponseSignaler = async (
      _config,
      workflowId,
      params,
    ) => {
      responseSignals.push({ workflowId, params });
      return { workflowId, signal: 'captureResponse' };
    };
    const app = createApp(
      config,
      sessions,
      chat,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      pairPromptWorkflowStarter,
      pairPromptResponseSignaler,
    );
    const listener = app.listen(0);
    server = listener;
    const address = listener.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected TCP listener');
    const base = `http://127.0.0.1:${address.port}`;
    const ownerAuth = {
      Authorization: 'Dev owner@acme.test',
      'Content-Type': 'application/json',
    };
    const reviewerAuth = {
      Authorization: 'Dev reviewer@acme.test',
      'Content-Type': 'application/json',
    };

    const created = await fetch(
      `${base}/diwan/api/code/sessions/${session.id}/pair-prompts`,
      {
        method: 'POST',
        headers: ownerAuth,
        body: JSON.stringify({ initialText: 'workflow approved prompt' }),
      },
    );
    const createdBody = await created.json();
    await fetch(
      `${base}/diwan/api/code/sessions/${session.id}/pair-prompts/${createdBody.draft.id}/ready`,
      { method: 'POST', headers: ownerAuth },
    );
    await fetch(
      `${base}/diwan/api/code/sessions/${session.id}/pair-prompts/${createdBody.draft.id}/approve`,
      { method: 'POST', headers: reviewerAuth },
    );

    const captured = await fetch(
      `${base}/diwan/api/code/sessions/${session.id}/pair-prompts/${createdBody.draft.id}/response`,
      {
        method: 'POST',
        headers: reviewerAuth,
        body: JSON.stringify({
          text: 'OpenCode completed the requested change.',
          source: 'opencode',
          messageId: 'msg-1',
        }),
      },
    );

    expect(captured.status).toBe(201);
    const capturedBody = await captured.json();
    expect(capturedBody.draft).toMatchObject({
      responseText: 'OpenCode completed the requested change.',
      responseSource: 'opencode',
      responseMessageId: 'msg-1',
      workflowId: 'pair-prompt-workflow-1',
    });
    expect(capturedBody.workflowSignal).toEqual({
      workflowId: 'pair-prompt-workflow-1',
      signal: 'captureResponse',
    });
    expect(responseSignals).toEqual([
      {
        workflowId: 'pair-prompt-workflow-1',
        params: {
          text: 'OpenCode completed the requested change.',
          source: 'opencode',
          messageId: 'msg-1',
        },
      },
    ]);
  });

  it('sends an approved pair prompt to the stored OpenCode session', async () => {
    const openCode = await fakeOpenCode((req, res) => {
      if (req.url === '/api/session/ses_opencode/prompt_async') {
        res.statusCode = 204;
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    const config: AppConfig = { ...testConfig(), NODE_ENV: 'development' };
    const sessions = new SessionStore(config.OPENCORTEX_DATA_DIR);
    const chat = new ChatStore(config);
    const owner = authUser('owner@acme.test');
    const session = codeSession({
      id: 'session-with-opencode-id',
      openCodeSessionId: 'ses_opencode',
      port: openCode.port,
      urlPath: '/diwan/code/session/session-with-opencode-id/',
    });
    sessions.set(session.id, session);
    const channel = chat.ensureSessionChannel(session, owner);
    chat.shareChannel(channel.id, 'reviewer@acme.test', owner);

    const app = createApp(config, sessions, chat);
    const listener = app.listen(0);
    server = listener;
    const address = listener.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected TCP listener');
    const base = `http://127.0.0.1:${address.port}`;
    const ownerAuth = {
      Authorization: 'Dev owner@acme.test',
      'Content-Type': 'application/json',
    };
    const reviewerAuth = {
      Authorization: 'Dev reviewer@acme.test',
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
    expect(openCode.requests.map(request => request.url)).toContain(
      '/api/session/ses_opencode/prompt_async',
    );
    expect(JSON.parse(openCode.requests[0].body)).toEqual({
      parts: [{ type: 'text', text: 'approved exact prompt' }],
    });
  });

  it('signals WorkbenchSessionWorkflow after a pair prompt send in workflow mode', async () => {
    const openCode = await fakeOpenCode((req, res) => {
      if (req.url === '/api/session/ses_opencode/prompt_async') {
        res.statusCode = 204;
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    const config: AppConfig = {
      ...testConfig(),
      NODE_ENV: 'development',
      OPENCORTEX_WORKBENCH_SESSION_MODE: 'workflow',
    };
    const sessions = new SessionStore(config.OPENCORTEX_DATA_DIR);
    const chat = new ChatStore(config);
    const owner = authUser('owner@acme.test');
    const session = codeSession({
      id: 'session-with-opencode-id',
      openCodeSessionId: 'ses_opencode',
      activeThreadId: 'thread-current',
      port: openCode.port,
      urlPath: '/diwan/code/session/session-with-opencode-id/',
    });
    sessions.set(session.id, session);
    const channel = chat.ensureSessionChannel(session, owner);
    chat.shareChannel(channel.id, 'reviewer@acme.test', owner);
    const workflowStore = new FakeWorkflowProjectionStore([
      workflowProjection({
        workflowId: 'workbench-session-owner-1',
        runId: 'run-workbench-1',
        workflowType: 'WorkbenchSessionWorkflow',
        status: 'running',
        ownerId: owner.email,
        sourceSystem: 'opencortex-runtime',
        sourceSessionId: session.id,
        entryIds: [],
      }),
    ]);
    const pairPromptSignals: Array<{
      workflowId: string;
      params: { prompt: string; threadId?: string };
    }> = [];
    const pairPromptSender: WorkbenchSessionWorkflowPairPromptSender = async (
      _config,
      workflowId,
      params,
    ) => {
      pairPromptSignals.push({ workflowId, params });
      return {
        workflowId,
        signal: 'sendPairPrompt',
      };
    };
    const app = createApp(
      config,
      sessions,
      chat,
      undefined,
      undefined,
      undefined,
      workflowStore,
      undefined,
      undefined,
      undefined,
      pairPromptSender,
    );
    const listener = app.listen(0);
    server = listener;
    const address = listener.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected TCP listener');
    const base = `http://127.0.0.1:${address.port}`;
    const ownerAuth = {
      Authorization: 'Dev owner@acme.test',
      'Content-Type': 'application/json',
    };
    const reviewerAuth = {
      Authorization: 'Dev reviewer@acme.test',
      'Content-Type': 'application/json',
    };

    const created = await fetch(
      `${base}/diwan/api/code/sessions/${session.id}/pair-prompts`,
      {
        method: 'POST',
        headers: ownerAuth,
        body: JSON.stringify({ initialText: 'workflow prompt' }),
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
    expect(approvedBody.workflowSignal).toEqual({
      workflowId: 'workbench-session-owner-1',
      signal: 'sendPairPrompt',
    });
    expect(pairPromptSignals).toEqual([
      {
        workflowId: 'workbench-session-owner-1',
        params: {
          prompt: 'workflow prompt',
          threadId: 'thread-current',
        },
      },
    ]);
  });
});
