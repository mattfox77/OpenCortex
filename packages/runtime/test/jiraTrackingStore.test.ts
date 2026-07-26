import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AuthenticatedUser } from '../src/auth/types.js';
import type { ChatChannel } from '../src/chat/chatStore.js';
import type { CodeSession } from '../src/code/sessionLauncher.js';
import { parseJiraReferences } from '../src/jira/jiraParser.js';
import { JiraTrackingStore } from '../src/jira/jiraTrackingStore.js';

function user(email = 'owner@dsn.com'): AuthenticatedUser {
  return {
    sub: `dev:${email}`,
    email,
    groups: ['TeamChatUsers', 'OpenCodeUsers'],
    linuxUser: email.split('@')[0],
  };
}

function session(overrides: Partial<CodeSession> = {}): CodeSession {
  return {
    id: 'sess-1',
    createdAt: '2026-06-10T00:00:00.000Z',
    ownerEmail: 'owner@dsn.com',
    linuxUser: 'owner',
    workspaceDir: '/home/owner/repos',
    port: 4100,
    urlPath: '/diwan/code/session/sess-1/',
    command: ['opencode', 'web'],
    mode: 'sudo',
    ...overrides,
  };
}

function channel(overrides: Partial<ChatChannel> = {}): ChatChannel {
  return {
    id: 'channel-1',
    type: 'session',
    name: 'owner / repos',
    createdAt: '2026-06-10T00:00:00.000Z',
    createdByEmail: 'owner@dsn.com',
    visibility: 'private',
    members: [
      {
        email: 'owner@dsn.com',
        linuxUser: 'owner',
        role: 'owner',
        addedAt: '2026-06-10T00:00:00.000Z',
        addedByEmail: 'owner@dsn.com',
      },
    ],
    session: {
      sessionId: 'sess-1',
      ownerEmail: 'owner@dsn.com',
      ownerLinuxUser: 'owner',
      workspaceDir: '/home/owner/repos',
      threadKey: 'session:owner@dsn.com:sess-1',
      urlPath: '/diwan/code/session/sess-1/',
    },
    ...overrides,
  };
}

describe('jira parser', () => {
  it('extracts unique Jira keys and URLs', () => {
    expect(
      parseJiraReferences(
        'See https://dsnsoft-dev.atlassian.net/browse/DSN-123 and dsn-123 plus OPS-9',
      ),
    ).toEqual([
      {
        key: 'DSN-123',
        url: 'https://dsnsoft-dev.atlassian.net/browse/DSN-123',
      },
      { key: 'OPS-9', url: undefined },
    ]);
  });
});

describe('JiraTrackingStore', () => {
  it('creates idempotent links and rebuilds from disk', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'jira-'));
    const store = new JiraTrackingStore(dataDir);
    const created = store.createFromText({
      session: session(),
      channel: channel(),
      actor: user(),
      source: 'chat-message',
      confidence: 'explicit',
      evidenceText: 'Working DSN-123 with team:Platform',
      evidenceRef: { type: 'chat-message', id: 'msg-1' },
    });

    expect(created).toHaveLength(2);
    store.createFromText({
      session: session(),
      channel: channel(),
      actor: user(),
      source: 'chat-message',
      confidence: 'explicit',
      evidenceText: 'Working DSN-123 with team:Platform',
      evidenceRef: { type: 'chat-message', id: 'msg-1' },
    });
    expect(store.listForSession('sess-1')).toHaveLength(2);

    const rebuilt = new JiraTrackingStore(dataDir);
    expect(rebuilt.listForSession('sess-1')).toHaveLength(2);
  });

  it('searches sessions by Jira item and team', () => {
    const store = new JiraTrackingStore(mkdtempSync(join(tmpdir(), 'jira-')));
    store.createFromText({
      session: session(),
      channel: channel(),
      actor: user(),
      source: 'manual',
      confidence: 'manual',
      evidenceText: 'DSN-456 team:Revenue',
    });

    const byIssue = store.searchSessions([session()], () => channel(), {
      jiraKey: 'DSN-456',
    });
    expect(byIssue.map(result => result.session.id)).toEqual(['sess-1']);

    const byTeam = store.searchSessions([session()], () => channel(), {
      teamName: 'Revenue',
    });
    expect(byTeam.map(result => result.session.id)).toEqual(['sess-1']);
  });

  it('reconstructs a Jira item detail from local links and cache data', () => {
    const store = new JiraTrackingStore(mkdtempSync(join(tmpdir(), 'jira-')));
    store.createFromText({
      session: session(),
      channel: channel(),
      actor: user(),
      source: 'chat-message',
      confidence: 'explicit',
      evidenceText: 'Implementing DSN-456 with the payment thread',
      evidenceRef: { type: 'chat-message', id: 'msg-1' },
    });

    const detail = store.getJiraItemDetail('dsn-456');

    expect(detail).toMatchObject({
      key: 'DSN-456',
      item: {
        key: 'DSN-456',
        projectKey: 'DSN',
      },
      sessionIds: ['sess-1'],
      sourceCounts: {
        'chat-message': 1,
      },
    });
    expect(detail?.integrationFormat.descriptionSection).toContain(
      '## Diwan Integration',
    );
  });

  it('soft deletes links', () => {
    const store = new JiraTrackingStore(mkdtempSync(join(tmpdir(), 'jira-')));
    const [link] = store.createFromText({
      session: session(),
      channel: channel(),
      actor: user(),
      source: 'manual',
      confidence: 'manual',
      evidenceText: 'DSN-789',
    });

    store.remove(link.id, user('other@dsn.com'));
    expect(store.listForSession('sess-1')).toEqual([]);
  });
});
