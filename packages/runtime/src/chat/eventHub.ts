import type express from 'express';
import { nanoid } from 'nanoid';
import type { AuthenticatedUser } from '../auth/types.js';
import type { ChatStore } from './chatStore.js';

export interface ChatEventEnvelope {
  id: string;
  createdAt: string;
  type:
    | 'channel.created'
    | 'channel.updated'
    | 'message.created'
    | 'pairPrompt.created'
    | 'pairPrompt.ready'
    | 'pairPrompt.reopened'
    | 'pairPrompt.rejected'
    | 'pairPrompt.sending'
    | 'pairPrompt.sent'
    | 'pairPrompt.failed'
    | 'jiraLinks.updated'
    | 'session.started'
    | 'session.archived';
  channelId?: string;
  payload: unknown;
}

interface Client {
  user: AuthenticatedUser;
  res: express.Response;
}

export class ChatEventHub {
  private readonly clients = new Set<Client>();

  constructor(private readonly chat: ChatStore) {}

  subscribe(user: AuthenticatedUser, res: express.Response): void {
    const keepAlive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 25000);
    keepAlive.unref();
    const client = { user, res };
    this.clients.add(client);
    res.writeHead(200, {
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    res.on('close', () => {
      clearInterval(keepAlive);
      this.clients.delete(client);
    });
  }

  publish(
    event: Omit<ChatEventEnvelope, 'id' | 'createdAt'>,
  ): ChatEventEnvelope {
    const envelope: ChatEventEnvelope = {
      id: nanoid(),
      createdAt: new Date().toISOString(),
      ...event,
    };
    const payload = `id: ${envelope.id}\nevent: ${envelope.type}\ndata: ${JSON.stringify(envelope)}\n\n`;

    for (const client of this.clients) {
      if (this.canReceive(client.user, envelope)) {
        client.res.write(payload);
      }
    }
    return envelope;
  }

  private canReceive(
    user: AuthenticatedUser,
    event: ChatEventEnvelope,
  ): boolean {
    if (!event.channelId) {
      return true;
    }
    return Boolean(this.chat.getChannelForUser(event.channelId, user));
  }
}
