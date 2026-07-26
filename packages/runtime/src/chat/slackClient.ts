import type { AppConfig } from '../config/config.js';
import type { ChatChannel } from './chatStore.js';
import type { CodeSession } from '../code/sessionLauncher.js';

interface SlackApiResponse {
  ok: boolean;
  error?: string;
}

interface SlackConversationResponse extends SlackApiResponse {
  channel?: {
    id: string;
    name?: string;
  };
}

interface SlackUserResponse extends SlackApiResponse {
  user?: {
    id: string;
  };
}

export interface SlackSessionChannel {
  channelId: string;
  channelName: string;
  url: string;
}

export class SlackClient {
  constructor(
    private readonly config: Pick<
      AppConfig,
      | 'SLACK_BOT_TOKEN'
      | 'SLACK_API_BASE_URL'
      | 'SLACK_WORKSPACE_URL'
      | 'SLACK_SESSION_CHANNEL_PREFIX'
      | 'DIWAN_PUBLIC_BASE_URL'
    >,
  ) {}

  get enabled(): boolean {
    return Boolean(this.config.SLACK_BOT_TOKEN.trim());
  }

  async ensureSessionChannel(
    session: CodeSession,
    channel: ChatChannel,
  ): Promise<SlackSessionChannel | undefined> {
    if (!this.enabled) {
      return undefined;
    }
    if (channel.external?.slack) {
      return channel.external.slack;
    }

    const channelName = sessionSlackChannelName(
      this.config.SLACK_SESSION_CHANNEL_PREFIX,
      session,
    );
    const created = await this.api<SlackConversationResponse>(
      'conversations.create',
      {
        name: channelName,
        is_private: true,
      },
    );
    const slackChannel = created.channel;
    if (!slackChannel?.id) {
      throw new Error('Slack did not return a channel id');
    }

    const result = {
      channelId: slackChannel.id,
      channelName: slackChannel.name ?? channelName,
      url: slackChannelUrl(this.config.SLACK_WORKSPACE_URL, slackChannel.id),
    };
    await this.postMessage(
      result.channelId,
      [
        `OpenCortex Workbench session started for ${session.ownerEmail}.`,
        `Session: ${new URL(session.urlPath, this.config.DIWAN_PUBLIC_BASE_URL).toString()}`,
        `Workspace: ${session.workspaceDir}`,
      ].join('\n'),
    );
    return result;
  }

  async inviteEmail(channelId: string, email: string): Promise<void> {
    if (!this.enabled) {
      return;
    }
    const lookup = await this.api<SlackUserResponse>('users.lookupByEmail', {
      email,
    });
    if (!lookup.user?.id) {
      throw new Error(`Slack user not found for ${email}`);
    }
    await this.api<SlackApiResponse>('conversations.invite', {
      channel: channelId,
      users: lookup.user.id,
    });
  }

  async postMessage(channelId: string, text: string): Promise<void> {
    if (!this.enabled) {
      return;
    }
    await this.api<SlackApiResponse>('chat.postMessage', {
      channel: channelId,
      text,
    });
  }

  private async api<T extends SlackApiResponse>(
    method: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const response = await fetch(
      `${this.config.SLACK_API_BASE_URL}/${method}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.SLACK_BOT_TOKEN}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(body),
      },
    );
    const payload = (await response.json()) as T;
    if (!response.ok || !payload.ok) {
      const error = payload.error ?? `http_${response.status}`;
      if (error === 'already_in_channel') {
        return payload;
      }
      throw new Error(`Slack ${method} failed: ${error}`);
    }
    return payload;
  }
}

function sessionSlackChannelName(prefix: string, session: CodeSession): string {
  const parts = [prefix, session.linuxUser, session.id.slice(0, 8)];
  return parts
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function slackChannelUrl(workspaceUrl: string, channelId: string): string {
  if (!workspaceUrl.trim()) {
    throw new Error('SLACK_WORKSPACE_URL is required when Slack integration is enabled');
  }
  return `${workspaceUrl.replace(/\/$/, '')}/archives/${channelId}`;
}
