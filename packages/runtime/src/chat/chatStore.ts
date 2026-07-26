import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { appendFile, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { nanoid } from 'nanoid';
import type { AuthenticatedUser } from '../auth/types.js';
import {
  assertAllowedEmailDomains,
  emailToLinuxUser,
} from '../auth/linuxUser.js';
import type { AppConfig } from '../config/config.js';
import {
  activeCodeThread,
  type CodeSession,
  type CodeThread,
} from '../code/sessionLauncher.js';

export type ChatChannelType = 'global' | 'session' | 'project';
export type ChatChannelVisibility = 'team' | 'private' | 'shared';
export type ChatChannelRole = 'owner' | 'member';
export type ChatMessageKind = 'user' | 'system';

export interface ChatChannelMember {
  email: string;
  linuxUser: string;
  role: ChatChannelRole;
  addedAt: string;
  addedByEmail: string;
}

export interface SessionChannelBinding {
  sessionId?: string;
  threadId?: string;
  openCodeSessionId?: string;
  ownerEmail: string;
  ownerLinuxUser: string;
  workspaceDir: string;
  threadKey: string;
  urlPath?: string;
  lastStartedAt?: string;
  lastEndedAt?: string;
}

export interface SlackChannelBinding {
  channelId: string;
  channelName: string;
  url: string;
  createdAt: string;
}

export interface ChatChannel {
  id: string;
  type: ChatChannelType;
  name: string;
  createdAt: string;
  createdByEmail: string;
  visibility: ChatChannelVisibility;
  members: ChatChannelMember[];
  archivedAt?: string;
  lastMessageAt?: string;
  session?: SessionChannelBinding;
  external?: {
    slack?: SlackChannelBinding;
  };
}

export interface ChatMessage {
  id: string;
  channelId: string;
  createdAt: string;
  authorEmail: string;
  authorLinuxUser: string;
  body: string;
  kind: ChatMessageKind;
  threadRootId?: string;
  mentions?: string[];
  reactions?: Record<string, string[]>;
  metadata?: Record<string, unknown>;
}

interface LegacyChatMessage {
  id: string;
  createdAt: string;
  authorEmail: string;
  authorLinuxUser: string;
  body: string;
}

const generalChannelId = 'general';

export class ChatStore {
  private readonly legacyFilePath: string;
  private readonly channelsFilePath: string;
  private readonly messagesDir: string;
  private channels = new Map<string, ChatChannel>();

  constructor(
    private readonly config: Pick<
      AppConfig,
      | 'OPENCORTEX_DATA_DIR'
      | 'OPENCORTEX_ALLOWED_EMAIL_DOMAINS'
      | 'OPENCORTEX_LINUX_USER_PREFIX'
    >,
  ) {
    this.legacyFilePath = join(config.OPENCORTEX_DATA_DIR, 'chat.jsonl');
    this.channelsFilePath = join(
      config.OPENCORTEX_DATA_DIR,
      'chat',
      'channels.json',
    );
    this.messagesDir = join(config.OPENCORTEX_DATA_DIR, 'chat', 'messages');
    mkdirSync(dirname(this.channelsFilePath), { recursive: true });
    mkdirSync(this.messagesDir, { recursive: true });
    this.loadChannels();
    this.ensureGeneralChannel();
    this.migrateLegacyGeneralMessages();
  }

  listChannelsForUser(user: AuthenticatedUser): ChatChannel[] {
    return [...this.channels.values()]
      .filter(channel => this.canReadChannel(channel, user))
      .sort((a, b) => {
        const aTime = a.lastMessageAt ?? a.createdAt;
        const bTime = b.lastMessageAt ?? b.createdAt;
        return bTime.localeCompare(aTime);
      });
  }

  getChannelForUser(
    channelId: string,
    user: AuthenticatedUser,
  ): ChatChannel | undefined {
    const channel = this.channels.get(channelId);
    if (!channel || !this.canReadChannel(channel, user)) {
      return undefined;
    }
    return channel;
  }

  getChannelForSession(
    session: Pick<CodeSession, 'id'>,
  ): ChatChannel | undefined {
    const thread = isCodeSession(session)
      ? activeCodeThread(session)
      : undefined;
    if (thread) {
      const channel = this.getChannelForSessionThread(session, thread);
      if (channel) {
        return channel;
      }
    }
    return [...this.channels.values()].find(
      channel =>
        channel.type === 'session' && channel.session?.sessionId === session.id,
    );
  }

  getChannelForSessionThread(
    session: Pick<CodeSession, 'id'>,
    thread: Pick<CodeThread, 'id'>,
  ): ChatChannel | undefined {
    return [...this.channels.values()].find(
      channel =>
        channel.type === 'session' &&
        channel.session?.sessionId === session.id &&
        channel.session?.threadId === thread.id,
    );
  }

  listLiveSessionChannels(session: Pick<CodeSession, 'id'>): ChatChannel[] {
    return [...this.channels.values()].filter(
      channel =>
        channel.type === 'session' &&
        !channel.archivedAt &&
        channel.session?.sessionId === session.id,
    );
  }

  userCanAccessSession(session: CodeSession, user: AuthenticatedUser): boolean {
    if (user.isSuperAdmin) {
      return true;
    }
    if (session.ownerEmail === user.email) {
      return true;
    }
    const channel = this.getChannelForSession(session);
    return channel ? this.isMember(channel, user.email) : false;
  }

  ensureSessionChannel(
    session: CodeSession,
    owner: AuthenticatedUser,
  ): ChatChannel {
    const now = new Date().toISOString();
    const thread = activeCodeThread(session);
    const threadKey = sessionThreadKey(
      session.ownerEmail,
      session.id,
      thread?.id,
    );
    const existing = [...this.channels.values()].find(
      channel =>
        channel.type === 'session' &&
        channel.session?.sessionId === session.id &&
        (channel.session.threadId === thread?.id ||
          (thread && !channel.session.threadId)),
    );

    if (existing) {
      const wasArchived = Boolean(existing.archivedAt);
      existing.archivedAt = undefined;
      existing.session = {
        ...existing.session,
        sessionId: session.id,
        ...(thread
          ? { threadId: thread.id, openCodeSessionId: thread.openCodeSessionId }
          : {}),
        ownerEmail: session.ownerEmail,
        ownerLinuxUser: session.linuxUser,
        workspaceDir: session.workspaceDir,
        threadKey,
        urlPath: session.urlPath,
        lastStartedAt: now,
      };
      existing.name = sessionChannelName(session, thread);
      if (!this.isMember(existing, owner.email)) {
        existing.members.push(memberFromUser(owner, 'owner', now, owner.email));
      }
      this.persistChannels();
      if (wasArchived) {
        void this.appendSystemMessage(existing.id, 'Session resumed.', {
          sessionId: session.id,
        });
      }
      return existing;
    }

    const channel: ChatChannel = {
      id: `session-${nanoid(12)}`,
      type: 'session',
      name: sessionChannelName(session, thread),
      createdAt: now,
      createdByEmail: owner.email,
      visibility: 'private',
      members: [memberFromUser(owner, 'owner', now, owner.email)],
      session: {
        sessionId: session.id,
        ...(thread
          ? { threadId: thread.id, openCodeSessionId: thread.openCodeSessionId }
          : {}),
        ownerEmail: session.ownerEmail,
        ownerLinuxUser: session.linuxUser,
        workspaceDir: session.workspaceDir,
        threadKey,
        urlPath: session.urlPath,
        lastStartedAt: now,
      },
    };
    this.channels.set(channel.id, channel);
    this.persistChannels();
    return channel;
  }

  updateSessionChannelName(session: CodeSession): boolean {
    const channel = this.getChannelForSession(session);
    if (!channel) {
      return false;
    }
    const nextName = sessionChannelName(session, activeCodeThread(session));
    if (channel.name === nextName) {
      return false;
    }
    channel.name = nextName;
    this.persistChannels();
    return true;
  }

  updateSessionThreadChannelName(
    session: CodeSession,
    thread: CodeThread,
  ): boolean {
    const channel = this.getChannelForSessionThread(session, thread);
    if (!channel) {
      return false;
    }
    const nextName = sessionChannelName(session, thread);
    if (channel.name === nextName) {
      return false;
    }
    channel.name = nextName;
    this.persistChannels();
    return true;
  }

  shareChannel(
    channelId: string,
    email: string,
    actor: AuthenticatedUser,
  ): ChatChannel {
    const channel = this.channels.get(channelId);
    if (!channel || !this.canReadChannel(channel, actor)) {
      throw new Error('Channel not found');
    }
    if (!this.isOwner(channel, actor.email)) {
      throw new Error('Only channel owners can share this channel');
    }
    if (channel.type !== 'session') {
      throw new Error('Only session channels can be shared');
    }

    const normalizedEmail = email.trim().toLowerCase();
    assertAllowedEmailDomains(
      normalizedEmail,
      this.config.OPENCORTEX_ALLOWED_EMAIL_DOMAINS,
    );
    if (!this.isMember(channel, normalizedEmail)) {
      const now = new Date().toISOString();
      channel.members.push({
        email: normalizedEmail,
        linuxUser: emailToLinuxUser(normalizedEmail, this.config),
        role: 'member',
        addedAt: now,
        addedByEmail: actor.email,
      });
      channel.visibility = 'shared';
      this.persistChannels();
      void this.appendSystemMessage(
        channel.id,
        `${actor.email} shared this session with ${normalizedEmail}.`,
        { sharedWith: normalizedEmail },
      );
    }
    return channel;
  }

  attachSlackChannel(
    channelId: string,
    slack: Omit<SlackChannelBinding, 'createdAt'>,
  ): ChatChannel {
    const channel = this.channels.get(channelId);
    if (!channel) {
      throw new Error('Channel not found');
    }
    channel.external = {
      ...channel.external,
      slack: {
        ...slack,
        createdAt:
          channel.external?.slack?.createdAt ?? new Date().toISOString(),
      },
    };
    this.persistChannels();
    return channel;
  }

  archiveSessionChannel(session: CodeSession): ChatChannel | undefined {
    const channel = this.getChannelForSession(session);
    if (!channel || channel.archivedAt) {
      return channel;
    }
    const now = new Date().toISOString();
    channel.archivedAt = now;
    if (channel.session) {
      channel.session.lastEndedAt = now;
      channel.session.sessionId = undefined;
      channel.session.urlPath = undefined;
    }
    this.persistChannels();
    return channel;
  }

  archiveSessionChannelsNotMatchingOpenCodeIds(
    session: CodeSession,
    liveOpenCodeSessionIds: Set<string>,
  ): ChatChannel[] {
    const archived: ChatChannel[] = [];
    const now = new Date().toISOString();
    for (const channel of this.channels.values()) {
      if (
        channel.type !== 'session' ||
        channel.archivedAt ||
        channel.session?.sessionId !== session.id
      ) {
        continue;
      }
      const openCodeSessionId = channel.session.openCodeSessionId;
      if (openCodeSessionId && liveOpenCodeSessionIds.has(openCodeSessionId)) {
        continue;
      }
      channel.archivedAt = now;
      channel.session.lastEndedAt = now;
      channel.session.sessionId = undefined;
      channel.session.urlPath = undefined;
      archived.push(channel);
    }
    if (archived.length > 0) {
      this.persistChannels();
    }
    return archived;
  }

  archiveSessionChannelsNotMatchingThreads(
    session: CodeSession,
  ): ChatChannel[] {
    const threads = session.threads ?? [];
    if (threads.length === 0) {
      return [];
    }
    const liveThreadIds = new Set(threads.map(thread => thread.id));
    const liveOpenCodeSessionIds = new Set(
      threads.map(thread => thread.openCodeSessionId),
    );
    const archived: ChatChannel[] = [];
    const now = new Date().toISOString();
    for (const channel of this.channels.values()) {
      if (
        channel.type !== 'session' ||
        channel.archivedAt ||
        channel.session?.sessionId !== session.id
      ) {
        continue;
      }
      const threadId = channel.session.threadId;
      const openCodeSessionId = channel.session.openCodeSessionId;
      const matchesThread =
        (threadId && liveThreadIds.has(threadId)) ||
        (openCodeSessionId && liveOpenCodeSessionIds.has(openCodeSessionId));
      if (matchesThread) {
        continue;
      }
      channel.archivedAt = now;
      channel.session.lastEndedAt = now;
      channel.session.sessionId = undefined;
      channel.session.urlPath = undefined;
      archived.push(channel);
    }
    if (archived.length > 0) {
      this.persistChannels();
    }
    return archived;
  }

  async listMessages(
    channelId: string,
    user: AuthenticatedUser,
    limit = 100,
  ): Promise<ChatMessage[]> {
    const channel = this.getChannelForUser(channelId, user);
    if (!channel) {
      throw new Error('Channel not found');
    }
    await this.ensureMessageFile(channel.id);
    const messages: ChatMessage[] = [];
    const input = createReadStream(this.messageFilePath(channel.id), {
      encoding: 'utf8',
    });
    const lines = createInterface({
      input,
      crlfDelay: Number.POSITIVE_INFINITY,
    });

    for await (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      messages.push(JSON.parse(line) as ChatMessage);
    }

    if (!Number.isFinite(limit)) {
      return messages;
    }
    return messages.slice(-Math.max(1, Math.min(limit, 500)));
  }

  async appendMessage(
    channelId: string,
    user: AuthenticatedUser,
    body: string,
  ): Promise<ChatMessage> {
    const channel = this.getChannelForUser(channelId, user);
    if (!channel) {
      throw new Error('Channel not found');
    }
    const message = await this.appendMessageRecord(channel, {
      authorEmail: user.email,
      authorLinuxUser: user.linuxUser,
      body,
      kind: 'user',
    });
    return message;
  }

  async list(limit = 100): Promise<ChatMessage[]> {
    const systemUser = generalSystemUser(this.config);
    return this.listMessages(generalChannelId, systemUser, limit);
  }

  async append(user: AuthenticatedUser, body: string): Promise<ChatMessage> {
    return this.appendMessage(generalChannelId, user, body);
  }

  private ensureGeneralChannel(): ChatChannel {
    const existing = this.channels.get(generalChannelId);
    if (existing) {
      return existing;
    }
    const now = new Date().toISOString();
    const channel: ChatChannel = {
      id: generalChannelId,
      type: 'global',
      name: 'general',
      createdAt: now,
      createdByEmail: 'system',
      visibility: 'team',
      members: [],
    };
    this.channels.set(channel.id, channel);
    this.persistChannels();
    return channel;
  }

  async appendSystemMessage(
    channelId: string,
    body: string,
    metadata?: Record<string, unknown>,
  ): Promise<ChatMessage> {
    const channel = this.channels.get(channelId);
    if (!channel) {
      throw new Error('Channel not found');
    }
    return this.appendMessageRecord(channel, {
      authorEmail: 'system',
      authorLinuxUser: 'system',
      body,
      kind: 'system',
      metadata,
    });
  }

  private async appendMessageRecord(
    channel: ChatChannel,
    input: {
      authorEmail: string;
      authorLinuxUser: string;
      body: string;
      kind: ChatMessageKind;
      metadata?: Record<string, unknown>;
    },
  ): Promise<ChatMessage> {
    const trimmed = input.body.trim();
    if (!trimmed) {
      throw new Error('Message body is required');
    }
    if (trimmed.length > 4000) {
      throw new Error('Message body exceeds 4000 characters');
    }

    const message: ChatMessage = {
      id: nanoid(),
      channelId: channel.id,
      createdAt: new Date().toISOString(),
      authorEmail: input.authorEmail,
      authorLinuxUser: input.authorLinuxUser,
      body: trimmed,
      kind: input.kind,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
    await appendFile(
      this.messageFilePath(channel.id),
      `${JSON.stringify(message)}\n`,
      {
        encoding: 'utf8',
      },
    );
    channel.lastMessageAt = message.createdAt;
    this.persistChannels();
    return message;
  }

  private canReadChannel(
    channel: ChatChannel,
    user: Pick<AuthenticatedUser, 'email' | 'isSuperAdmin'>,
  ): boolean {
    if (user.isSuperAdmin) {
      return true;
    }
    return channel.visibility === 'team' || this.isMember(channel, user.email);
  }

  private isOwner(channel: ChatChannel, email: string): boolean {
    return channel.members.some(
      member => member.email === email && member.role === 'owner',
    );
  }

  private isMember(channel: ChatChannel, email: string): boolean {
    return channel.members.some(member => member.email === email);
  }

  private loadChannels(): void {
    if (!existsSync(this.channelsFilePath)) {
      return;
    }
    const raw = readFileSync(this.channelsFilePath, 'utf8').trim();
    if (!raw) {
      return;
    }
    const channels = JSON.parse(raw) as ChatChannel[];
    this.channels = new Map(channels.map(channel => [channel.id, channel]));
  }

  private persistChannels(): void {
    mkdirSync(dirname(this.channelsFilePath), { recursive: true });
    const payload = JSON.stringify([...this.channels.values()], null, 2);
    const tmpPath = `${this.channelsFilePath}.tmp`;
    writeFileSync(tmpPath, `${payload}\n`, { encoding: 'utf8' });
    renameSync(tmpPath, this.channelsFilePath);
  }

  private migrateLegacyGeneralMessages(): void {
    const generalPath = this.messageFilePath(generalChannelId);
    if (!existsSync(this.legacyFilePath) || existsSync(generalPath)) {
      return;
    }
    const raw = readFileSync(this.legacyFilePath, 'utf8');
    const migrated = raw
      .split(/\r?\n/)
      .filter(line => line.trim())
      .map(line => {
        const legacy = JSON.parse(line) as LegacyChatMessage;
        const message: ChatMessage = {
          ...legacy,
          channelId: generalChannelId,
          kind: 'user',
        };
        return JSON.stringify(message);
      })
      .join('\n');
    writeFileSync(generalPath, migrated ? `${migrated}\n` : '', {
      encoding: 'utf8',
    });
  }

  private messageFilePath(channelId: string): string {
    return join(this.messagesDir, `${safeChannelFileName(channelId)}.jsonl`);
  }

  private async ensureMessageFile(channelId: string): Promise<void> {
    mkdirSync(this.messagesDir, { recursive: true });
    const handle = await open(this.messageFilePath(channelId), 'a');
    await handle.close();
  }
}

function memberFromUser(
  user: AuthenticatedUser,
  role: ChatChannelRole,
  addedAt: string,
  addedByEmail: string,
): ChatChannelMember {
  return {
    email: user.email,
    linuxUser: user.linuxUser,
    role,
    addedAt,
    addedByEmail,
  };
}

function sessionThreadKey(
  ownerEmail: string,
  sessionId: string,
  threadId?: string,
): string {
  return ['session', ownerEmail, sessionId, threadId].filter(Boolean).join(':');
}

function sessionChannelName(
  session: Pick<CodeSession, 'name'>,
  thread?: Pick<CodeThread, 'name'>,
): string {
  const name = thread?.name?.trim() || session.name?.trim();
  return name || 'New session';
}

function isCodeSession(
  session: Pick<CodeSession, 'id'>,
): session is CodeSession {
  return (
    'ownerEmail' in session &&
    'linuxUser' in session &&
    'workspaceDir' in session &&
    'createdAt' in session
  );
}

function safeChannelFileName(channelId: string): string {
  return channelId.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function generalSystemUser(
  config: Pick<AppConfig, 'OPENCORTEX_LINUX_USER_PREFIX'>,
): AuthenticatedUser {
  return {
    sub: 'system:general',
    email: 'system',
    groups: [],
    linuxUser: `${config.OPENCORTEX_LINUX_USER_PREFIX}system`.slice(0, 31),
  };
}
