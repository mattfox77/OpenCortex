import http, { type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HttpOpenCodePromptClient,
  createOpenCodeSession,
  fetchOpenCodeSessions,
  fetchOpenCodeSessionName,
} from '../src/code/openCodePromptClient.js';
import type { CodeSession } from '../src/code/sessionLauncher.js';

const servers: Server[] = [];

function listen(
  handler: http.RequestListener,
): Promise<{ port: number; requests: string[] }> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    handler(req, res);
  });
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Expected TCP address'));
        return;
      }
      resolve({ port: address.port, requests });
    });
  });
}

function session(port: number): CodeSession {
  return {
    id: 'diwan-session',
    openCodeSessionId: 'ses_test',
    createdAt: '2026-06-10T00:00:00.000Z',
    ownerEmail: 'owner@acme.test',
    linuxUser: 'owner',
    workspaceDir: '/home/owner/repos',
    port,
    urlPath: '/diwan/code/session/diwan-session/',
    command: ['opencode', 'web'],
    mode: 'sudo',
  };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      server =>
        new Promise<void>(resolve => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe('OpenCode prompt client', () => {
  it('creates and returns a dyson-opencode internal session id', async () => {
    const { port, requests } = await listen((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: 'ses_created' }));
    });

    await expect(createOpenCodeSession(port)).resolves.toBe('ses_created');
    expect(requests).toEqual(['POST /api/session']);
  });

  it('sends prompts to dyson-opencode async endpoint first', async () => {
    const { port, requests } = await listen((req, res) => {
      if (req.url === '/api/session/ses_test/prompt_async') {
        res.statusCode = 204;
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });

    const client = new HttpOpenCodePromptClient();
    await expect(
      client.sendPrompt({
        session: session(port),
        opencodeSessionId: 'ses_test',
        promptText: 'approved',
        draftId: 'draft',
        approvedByEmail: 'reviewer@acme.test',
      }),
    ).resolves.toEqual({});
    expect(requests).toEqual(['POST /api/session/ses_test/prompt_async']);
  });

  it('reads dyson-opencode session names from nested session payloads', async () => {
    const { port, requests } = await listen((req, res) => {
      if (req.url === '/api/session/ses_test') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: { session: { title: 'Greeting' } } }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });

    await expect(fetchOpenCodeSessionName(session(port))).resolves.toBe(
      'Greeting',
    );
    expect(requests).toEqual(['GET /api/session/ses_test']);
  });

  it('reads dyson-opencode session lists from nested payloads', async () => {
    const { port, requests } = await listen((req, res) => {
      if (req.url === '/api/session') {
        res.setHeader('Content-Type', 'application/json');
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
                  sessionID: 'ses_clone',
                  name: 'Clone ExampleOrg/repo',
                  cwd: '/home/owner/repos/repo',
                },
              ],
            },
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });

    await expect(fetchOpenCodeSessions(session(port))).resolves.toEqual([
      {
        id: 'ses_pull',
        name: 'Pull payments-core',
        workspaceDir: '/home/owner/repos/payments-core',
      },
      {
        id: 'ses_clone',
        name: 'Clone ExampleOrg/repo',
        workspaceDir: '/home/owner/repos/repo',
      },
    ]);
    expect(requests).toEqual(['GET /api/session']);
  });
});
