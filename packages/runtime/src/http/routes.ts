import express from 'express';
import httpProxy from 'http-proxy';
import { z } from 'zod';
import type { AppConfig } from '../config/config.js';
import { ChatStore, type ChatChannel } from '../chat/chatStore.js';
import { ChatEventHub } from '../chat/eventHub.js';
import { SlackClient } from '../chat/slackClient.js';
import {
  activeCodeThread,
  archiveWorkbenchSessionWorkflow,
  attachWorkbenchIssueWorkflow,
  SessionLauncher,
  sendWorkbenchPairPromptWorkflow,
  sessionWithActiveThread,
  startWorkbenchSessionWorkflow,
  type CodeSession,
  type CodeThread,
  type WorkbenchSessionWorkflowSignal,
  type WorkbenchSessionWorkflowStart,
} from '../code/sessionLauncher.js';
import { isSessionRestorable, SessionStore } from '../code/sessionStore.js';
import {
  fetchOpenCodeSessions,
  fetchOpenCodeSessionNameById,
  HttpOpenCodePromptClient,
  type OpenCodePromptClient,
} from '../code/openCodePromptClient.js';
import { oidcProviderMetadata, requireUser } from '../auth/oidc.js';
import type { AuthenticatedUser } from '../auth/types.js';
import {
  mintInternalToken,
  parseInternalTokenScopes,
  verifyInternalToken,
  type InternalTokenScope,
  type VerifiedInternalToken,
} from '../auth/internalToken.js';
import type {
  MemoryEntryAuthor,
  MemoryEntryKind,
  MemoryEntryScope,
  MemoryStore,
} from '../memory/memoryStore.js';
import { provisioningCommands } from '../system/provisioning.js';
import {
  PairPromptStore,
  type PairPromptDraft,
} from '../pairPrompts/pairPromptStore.js';
import {
  JiraTrackingStore,
  type JiraSessionLinkConfidence,
  type JiraSessionLinkSource,
} from '../jira/jiraTrackingStore.js';
import {
  type WorkflowProjection,
  type WorkflowProjectionStatus,
  type WorkflowProjectionStore,
} from '../workflows/workflowProjectionStore.js';

const tokenExchangeResponseSchema = z.object({
  id_token: z.string().optional(),
  access_token: z.string().optional(),
  expires_in: z.number().optional(),
  token_type: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

const workflowStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'cancelled',
]) satisfies z.ZodType<WorkflowProjectionStatus>;

const workflowListQuerySchema = z.object({
  workflowType: z.string().min(1).optional(),
  status: workflowStatusSchema.optional(),
  project: z.string().min(1).optional(),
  sourceSystem: z.string().min(1).optional(),
  sourceSessionId: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

export type WorkbenchSessionWorkflowStarter = (
  config: AppConfig,
  user: Pick<AuthenticatedUser, 'email' | 'linuxUser' | 'sub'>,
) => Promise<WorkbenchSessionWorkflowStart>;

export type WorkbenchSessionWorkflowArchiver = (
  config: AppConfig,
  workflowId: string,
  reason?: string,
) => Promise<WorkbenchSessionWorkflowSignal>;

export type WorkbenchSessionWorkflowIssueAttacher = (
  config: AppConfig,
  workflowId: string,
  params: { issueKey: string; url?: string },
) => Promise<WorkbenchSessionWorkflowSignal>;

export type WorkbenchSessionWorkflowPairPromptSender = (
  config: AppConfig,
  workflowId: string,
  params: { prompt: string; threadId?: string },
) => Promise<WorkbenchSessionWorkflowSignal>;

export function publicRouter(config: AppConfig): express.Router {
  const router = express.Router();

  router.get('/auth/config', async (_req, res, next) => {
    try {
      const metadata = await oidcProviderMetadata(config);
      const logoutUrl = metadata.end_session_endpoint
        ? `${metadata.end_session_endpoint}?${new URLSearchParams({
            client_id: config.OIDC_CLIENT_ID,
            post_logout_redirect_uri: config.OPENCORTEX_PUBLIC_BASE_URL,
          }).toString()}`
        : config.OPENCORTEX_PUBLIC_BASE_URL;

      res.json({
        authorizationEndpoint: metadata.authorization_endpoint,
        clientId: config.OIDC_CLIENT_ID,
        redirectUri: new URL(
          config.OIDC_REDIRECT_PATH.replace(/^\//, ''),
          config.OPENCORTEX_PUBLIC_BASE_URL,
        ).toString(),
        logoutUrl,
        basePath: config.OPENCORTEX_BASE_PATH,
        scope: config.OIDC_SCOPES.join(' '),
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/auth/token', async (req, res, next) => {
    try {
      const body = z
        .object({
          code: z.string().min(1),
          codeVerifier: z.string().min(1),
        })
        .parse(req.body);
      const metadata = await oidcProviderMetadata(config);
      const tokenBody = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: config.OIDC_CLIENT_ID,
        redirect_uri: new URL(
          config.OIDC_REDIRECT_PATH.replace(/^\//, ''),
          config.OPENCORTEX_PUBLIC_BASE_URL,
        ).toString(),
        code: body.code,
        code_verifier: body.codeVerifier,
      });
      if (config.OIDC_CLIENT_SECRET) {
        tokenBody.set('client_secret', config.OIDC_CLIENT_SECRET);
      }

      const tokenResponse = await fetch(
        metadata.token_endpoint,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: tokenBody,
        },
      );
      const tokenPayload = tokenExchangeResponseSchema.parse(
        await tokenResponse.json(),
      );

      if (!tokenResponse.ok) {
        return res.status(400).json({
          error: 'token_exchange_failed',
          message:
            tokenPayload.error_description ??
            tokenPayload.error ??
            'OIDC token exchange failed',
        });
      }

      return res.json({
        idToken: tokenPayload.id_token,
        accessToken: tokenPayload.access_token,
        expiresIn: tokenPayload.expires_in,
        tokenType: tokenPayload.token_type,
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

export function apiRouter(
  config: AppConfig,
  sessions: SessionStore,
  chat: ChatStore,
  pairPrompts: PairPromptStore,
  jiraTracking: JiraTrackingStore,
  openCodePromptClient: OpenCodePromptClient = new HttpOpenCodePromptClient(),
  workflowProjections?: WorkflowProjectionStore,
  workbenchSessionWorkflowStarter: WorkbenchSessionWorkflowStarter =
    startWorkbenchSessionWorkflow,
  workbenchSessionWorkflowArchiver: WorkbenchSessionWorkflowArchiver =
    archiveWorkbenchSessionWorkflow,
  workbenchSessionWorkflowIssueAttacher: WorkbenchSessionWorkflowIssueAttacher =
    attachWorkbenchIssueWorkflow,
  workbenchSessionWorkflowPairPromptSender: WorkbenchSessionWorkflowPairPromptSender =
    sendWorkbenchPairPromptWorkflow,
): express.Router {
  const router = express.Router();
  const launcher = new SessionLauncher(config);
  const events = new ChatEventHub(chat);
  const slack = new SlackClient(config);

  router.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'opencortex-runtime' });
  });

  router.get('/me', requireUser, (req, res) => {
    res.json({ user: req.user });
  });

  router.post('/auth/internal-token', requireUser, async (req, res, next) => {
    try {
      const body = z
        .object({
          scopes: z.array(z.string()).min(1),
          ttlSeconds: z.number().int().positive().max(3600).optional(),
        })
        .parse(req.body);
      const scopes = parseInternalTokenScopes(body.scopes);
      const minted = await mintInternalToken({
        user: req.user!,
        scopes,
        secret: config.OPENCORTEX_INTERNAL_TOKEN_SECRET,
        ttlSeconds: body.ttlSeconds,
      });
      res.status(201).json({
        token: minted.token,
        tokenType: 'Bearer',
        scopes,
        expiresAt: minted.expiresAt.toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/chat/events', requireUser, (req, res) => {
    events.subscribe(req.user!, res);
  });

  router.get('/chat/messages', requireUser, async (req, res, next) => {
    try {
      const limit = messageLimit(req.query.limit);
      res.json({ messages: await chat.list(limit) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/chat/messages', requireUser, async (req, res, next) => {
    try {
      const body = z.object({ body: z.string() }).parse(req.body);
      const message = await chat.append(req.user!, body.body);
      events.publish({
        type: 'message.created',
        channelId: 'general',
        payload: { message },
      });
      res.status(201).json({ message });
    } catch (error) {
      next(error);
    }
  });

  router.get('/chat/channels', requireUser, async (req, res) => {
    await ensureOwnedSessionsRunning(sessions, chat, launcher, req.user!);
    await refreshVisibleSessionNames(sessions, chat, req.user!);
    res.json({ channels: chat.listChannelsForUser(req.user!) });
  });

  router.get(
    '/chat/channels/:channelId/messages',
    requireUser,
    async (req, res, next) => {
      try {
        const limit = messageLimit(req.query.limit);
        const channelId = String(req.params.channelId);
        res.json({
          messages: await chat.listMessages(channelId, req.user!, limit),
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/chat/channels/:channelId/messages',
    requireUser,
    async (req, res, next) => {
      try {
        const body = z.object({ body: z.string() }).parse(req.body);
        const channelId = String(req.params.channelId);
        const message = await chat.appendMessage(
          channelId,
          req.user!,
          body.body,
        );
        const linkedSession = sessionForChannel(sessions, chat, channelId);
        await mirrorMessageToSlack(slack, linkedSession?.channel, message);
        if (linkedSession) {
          jiraTracking.createFromText({
            session: linkedSession.session,
            channel: linkedSession.channel,
            actor: req.user!,
            source: 'chat-message',
            confidence: 'explicit',
            evidenceText: message.body,
            evidenceRef: {
              type: 'chat-message',
              id: message.id,
            },
          });
        }
        events.publish({
          type: 'message.created',
          channelId,
          payload: { message },
        });
        res.status(201).json({ message });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/chat/channels/:channelId/share',
    requireUser,
    async (req, res, next) => {
      try {
        const body = z.object({ email: z.string().email() }).parse(req.body);
        const channelId = String(req.params.channelId);
        const channel = chat.shareChannel(channelId, body.email, req.user!);
        await inviteSlackMember(slack, chat, channel, body.email);
        events.publish({
          type: 'channel.updated',
          channelId,
          payload: { channel },
        });
        res.json({ channel });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post('/code/sessions', requireUser, async (req, res, next) => {
    try {
      if (config.OPENCORTEX_WORKBENCH_SESSION_MODE === 'workflow') {
        const workflow = await workbenchSessionWorkflowStarter(config, req.user!);
        const projection = await workbenchSessionStartProjection(
          workflowProjections,
          workflow,
          req.user!,
        );
        return res.status(202).json({
          workflow,
          projection,
          message: 'WorkbenchSessionWorkflow started.',
        });
      }
      const result = await launchCodeSessionForUser({
        sessions,
        chat,
        slack,
        events,
        launcher,
        user: req.user!,
      });
      res.status(result.existing ? 200 : 201).json({
        session: result.session,
        channel: result.channel,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/code/sessions', requireUser, async (req, res) => {
    const ownerEmail = req.user!.email;
    await ensureOwnedSessionsRunning(sessions, chat, launcher, req.user!);
    await refreshVisibleSessionNames(sessions, chat, req.user!);
    const visible = visibleCodeSessionViews(sessions, chat, req.user!);
    res.json({
      sessions: visible.map(session => ({
        ...session,
        role: session.ownerEmail === ownerEmail ? 'owner' : 'member',
        channel: session.channel,
      })),
    });
  });

  router.delete('/code/sessions/:id', requireUser, async (req, res, next) => {
    try {
      const session = sessions.get(String(req.params.id));
      if (
        !session ||
        (session.ownerEmail !== req.user!.email && !req.user!.isSuperAdmin)
      ) {
        return res.status(404).json({ error: 'code_session_not_found' });
      }
      if (config.OPENCORTEX_WORKBENCH_SESSION_MODE === 'workflow') {
        const projection = await workbenchSessionProjectionForSession(
          workflowProjections,
          session,
          req.user!,
        );
        if (!projection) {
          return res.status(404).json({ error: 'workflow_projection_not_found' });
        }
        const workflow = await workbenchSessionWorkflowArchiver(
          config,
          projection.workflowId,
          `Archive requested for session ${session.id}`,
        );
        return res.status(202).json({
          workflow,
          projection,
          message: 'archiveSession signal sent.',
        });
      }
      const channel = chat.archiveSessionChannel(session);
      sessions.delete(session.id);
      events.publish({
        type: 'session.archived',
        channelId: channel?.id ?? `session-${session.id}`,
        payload: { session, channel },
      });
      return res.json({ session, channel });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/code/sessions/:id/channel', requireUser, (req, res) => {
    const session = sessions.get(String(req.params.id));
    if (!session || !chat.userCanAccessSession(session, req.user!)) {
      return res.status(404).json({ error: 'code_session_not_found' });
    }
    const channel = chat.getChannelForSession(session);
    if (!channel) {
      return res.status(404).json({ error: 'session_channel_not_found' });
    }
    return res.json({ channel });
  });

  router.get('/workflows', requireUser, async (req, res, next) => {
    try {
      const store = requireWorkflowProjectionStore(workflowProjections, res);
      if (!store) {
        return;
      }
      const query = workflowListQuerySchema.parse(req.query);
      const workflows = await store.list({
        ownerId: req.user!.email,
        isSuperAdmin: Boolean(req.user!.isSuperAdmin),
        limit: query.limit ?? 50,
        workflowType: query.workflowType,
        status: query.status,
        project: query.project,
        sourceSystem: query.sourceSystem,
        sourceSessionId: query.sourceSessionId,
      });
      return res.json({ workflows });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/workflows/:id', requireUser, async (req, res, next) => {
    try {
      const store = requireWorkflowProjectionStore(workflowProjections, res);
      if (!store) {
        return;
      }
      const workflow = await store.get(String(req.params.id), {
        ownerId: req.user!.email,
        isSuperAdmin: Boolean(req.user!.isSuperAdmin),
      });
      if (!workflow) {
        return res.status(404).json({ error: 'workflow_not_found' });
      }
      return res.json({ workflow });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/code/sessions/:id/pair-prompts', requireUser, (req, res) => {
    const resolved = resolveSessionAccess(
      sessions,
      chat,
      String(req.params.id),
      req.user!,
    );
    if (!resolved) {
      return res.status(404).json({ error: 'code_session_not_found' });
    }
    return res.json({
      drafts: pairPrompts.listForSession(resolved.session.id),
    });
  });

  router.post(
    '/code/sessions/:id/pair-prompts',
    requireUser,
    async (req, res, next) => {
      try {
        const body = z
          .object({ initialText: z.string().optional() })
          .parse(req.body);
        const resolved = resolveSessionAccess(
          sessions,
          chat,
          String(req.params.id),
          req.user!,
        );
        if (!resolved) {
          return res.status(404).json({ error: 'code_session_not_found' });
        }
        const draft = pairPrompts.create({
          session: resolved.session,
          channelId: resolved.channel.id,
          actor: req.user!,
          initialText: body.initialText,
        });
        if (body.initialText) {
          jiraTracking.createFromText({
            session: resolved.session,
            channel: resolved.channel,
            actor: req.user!,
            source: 'pair-prompt',
            confidence: 'explicit',
            evidenceText: body.initialText,
            evidenceRef: {
              type: 'pair-prompt',
              id: draft.id,
            },
          });
        }
        await publishPairPromptEvent(chat, events, resolved.channel.id, {
          type: 'pairPrompt.created',
          body: `${req.user!.email} created a pair prompt draft.`,
          draft,
        });
        return res.status(201).json({ draft });
      } catch (error) {
        return next(error);
      }
    },
  );

  router.patch(
    '/code/sessions/:id/pair-prompts/:draftId',
    requireUser,
    (req, res, next) => {
      try {
        const body = z.object({ text: z.string() }).parse(req.body);
        const resolved = resolveDraftAccess(
          sessions,
          chat,
          pairPrompts,
          String(req.params.id),
          String(req.params.draftId),
          req.user!,
        );
        if (!resolved) {
          return res.status(404).json({ error: 'pair_prompt_not_found' });
        }
        const draft = pairPrompts.updateText(
          resolved.draft.id,
          req.user!,
          body.text,
        );
        return res.json({ draft });
      } catch (error) {
        return next(error);
      }
    },
  );

  router.post(
    '/code/sessions/:id/pair-prompts/:draftId/ready',
    requireUser,
    async (req, res, next) => {
      try {
        const resolved = resolveDraftAccess(
          sessions,
          chat,
          pairPrompts,
          String(req.params.id),
          String(req.params.draftId),
          req.user!,
        );
        if (!resolved) {
          return res.status(404).json({ error: 'pair_prompt_not_found' });
        }
        const draft = pairPrompts.markReady(resolved.draft.id, req.user!);
        await publishPairPromptEvent(chat, events, resolved.channel.id, {
          type: 'pairPrompt.ready',
          body: `${req.user!.email} marked a pair prompt ready for approval.`,
          draft,
        });
        return res.json({ draft });
      } catch (error) {
        return next(error);
      }
    },
  );

  router.post(
    '/code/sessions/:id/pair-prompts/:draftId/reopen',
    requireUser,
    async (req, res, next) => {
      try {
        const body = z
          .object({ reason: z.string().optional() })
          .parse(req.body);
        const resolved = resolveDraftAccess(
          sessions,
          chat,
          pairPrompts,
          String(req.params.id),
          String(req.params.draftId),
          req.user!,
        );
        if (!resolved) {
          return res.status(404).json({ error: 'pair_prompt_not_found' });
        }
        const draft = pairPrompts.reopen(
          resolved.draft.id,
          req.user!,
          body.reason,
        );
        await publishPairPromptEvent(chat, events, resolved.channel.id, {
          type: 'pairPrompt.reopened',
          body: `${req.user!.email} reopened a pair prompt for editing.`,
          draft,
        });
        return res.json({ draft });
      } catch (error) {
        return next(error);
      }
    },
  );

  router.post(
    '/code/sessions/:id/pair-prompts/:draftId/reject',
    requireUser,
    async (req, res, next) => {
      try {
        const body = z
          .object({ reason: z.string().optional() })
          .parse(req.body);
        const resolved = resolveDraftAccess(
          sessions,
          chat,
          pairPrompts,
          String(req.params.id),
          String(req.params.draftId),
          req.user!,
        );
        if (!resolved) {
          return res.status(404).json({ error: 'pair_prompt_not_found' });
        }
        const draft = pairPrompts.reject(
          resolved.draft.id,
          req.user!,
          body.reason,
        );
        await publishPairPromptEvent(chat, events, resolved.channel.id, {
          type: 'pairPrompt.rejected',
          body: `${req.user!.email} rejected a pair prompt.`,
          draft,
        });
        return res.json({ draft });
      } catch (error) {
        return next(error);
      }
    },
  );

  router.post(
    '/code/sessions/:id/pair-prompts/:draftId/approve',
    requireUser,
    async (req, res, next) => {
      try {
        const resolved = resolveDraftAccess(
          sessions,
          chat,
          pairPrompts,
          String(req.params.id),
          String(req.params.draftId),
          req.user!,
        );
        if (!resolved) {
          return res.status(404).json({ error: 'pair_prompt_not_found' });
        }
        let draft = pairPrompts.startSending(resolved.draft.id, req.user!);
        await publishPairPromptEvent(chat, events, resolved.channel.id, {
          type: 'pairPrompt.sending',
          body: `${req.user!.email} approved a pair prompt; sending to OpenCode.`,
          draft,
        });

        const opencodeSessionId =
          draft.opencodeSessionId ?? resolved.session.openCodeSessionId;
        if (!opencodeSessionId) {
          draft = pairPrompts.markFailed(draft.id, {
            actor: req.user!,
            failureCode: 'missing_opencode_session_id',
            failureMessage:
              'OpenCortex does not yet know the active OpenCode internal session ID.',
          });
          await publishPairPromptEvent(chat, events, resolved.channel.id, {
            type: 'pairPrompt.failed',
            body: 'Pair prompt send failed before reaching OpenCode.',
            draft,
          });
          return res.status(409).json({ draft });
        }

        try {
          const result = await openCodePromptClient.sendPrompt({
            session: resolved.session,
            opencodeSessionId,
            promptText: draft.reviewSnapshotText!,
            draftId: draft.id,
            approvedByEmail: req.user!.email,
          });
          draft = pairPrompts.markSent(
            draft.id,
            req.user!,
            result.openCodeMessageId,
          );
          await publishPairPromptEvent(chat, events, resolved.channel.id, {
            type: 'pairPrompt.sent',
            body: 'Pair prompt was sent to OpenCode.',
            draft,
          });
          const workflowSignal =
            config.OPENCORTEX_WORKBENCH_SESSION_MODE === 'workflow'
              ? await sendPairPromptToWorkbenchWorkflow({
                  workflowProjections,
                  pairPromptSender: workbenchSessionWorkflowPairPromptSender,
                  config,
                  session: resolved.session,
                  user: req.user!,
                  prompt: draft.reviewSnapshotText!,
                  threadId: resolved.session.activeThreadId,
                })
              : undefined;
          return res.json({ draft, workflowSignal });
        } catch (error) {
          draft = pairPrompts.markFailed(draft.id, {
            actor: req.user!,
            failureCode: 'opencode_send_failed',
            failureMessage:
              error instanceof Error ? error.message : 'OpenCode send failed',
          });
          await publishPairPromptEvent(chat, events, resolved.channel.id, {
            type: 'pairPrompt.failed',
            body: 'Pair prompt send failed.',
            draft,
          });
          return res.status(502).json({ draft });
        }
      } catch (error) {
        return next(error);
      }
    },
  );

  router.get('/code/provisioning', requireUser, (req, res) => {
    res.json({
      linuxUser: req.user!.linuxUser,
      commands: provisioningCommands(req.user!, config),
    });
  });

  router.get('/code/sessions/:id/jira-links', requireUser, (req, res) => {
    const resolved = resolveSessionAccess(
      sessions,
      chat,
      String(req.params.id),
      req.user!,
    );
    if (!resolved) {
      return res.status(404).json({ error: 'code_session_not_found' });
    }
    return res.json({
      links: jiraTracking.listForSession(resolved.session.id),
    });
  });

  router.post(
    '/code/sessions/:id/jira-links',
    requireUser,
    async (req, res, next) => {
      try {
        const body = z
          .object({
            reference: z.string().min(1),
            source: z
              .enum([
                'manual',
                'chat-message',
                'pair-prompt',
                'session-launch',
                'git-branch',
                'git-commit',
                'pull-request',
                'jira-enrichment',
              ])
              .optional(),
            confidence: z.enum(['explicit', 'inferred', 'manual']).optional(),
            kind: z.enum(['issue', 'team']).optional(),
          })
          .parse(req.body);
        const resolved = resolveSessionAccess(
          sessions,
          chat,
          String(req.params.id),
          req.user!,
        );
        if (!resolved) {
          return res.status(404).json({ error: 'code_session_not_found' });
        }
        const links =
          body.kind === 'team'
            ? [
                jiraTracking.create({
                  session: resolved.session,
                  channel: resolved.channel,
                  actor: req.user!,
                  source: body.source ?? 'manual',
                  confidence: body.confidence ?? 'manual',
                  kind: 'team',
                  teamName: body.reference.trim(),
                  evidenceText: body.reference,
                  evidenceRef: {
                    type: body.source ?? 'manual',
                  },
                }),
              ]
            : jiraTracking.createFromText({
                session: resolved.session,
                channel: resolved.channel,
                actor: req.user!,
                source: body.source ?? 'manual',
                confidence: body.confidence ?? 'manual',
                evidenceText: body.reference,
                evidenceRef: {
                  type: body.source ?? 'manual',
                },
              });
        if (links.length === 0) {
          return res.status(422).json({ error: 'no_jira_reference_found' });
        }
        events.publish({
          type: 'jiraLinks.updated',
          channelId: resolved.channel.id,
          payload: { sessionId: resolved.session.id, links },
        });
        const workflowSignals =
          config.OPENCORTEX_WORKBENCH_SESSION_MODE === 'workflow'
            ? await attachIssuesToWorkbenchWorkflow({
                workflowProjections,
                issueAttacher: workbenchSessionWorkflowIssueAttacher,
                config,
                session: resolved.session,
                user: req.user!,
                links,
              })
            : [];
        return res.status(201).json({ links, workflowSignals });
      } catch (error) {
        return next(error);
      }
    },
  );

  router.delete(
    '/code/sessions/:id/jira-links/:linkId',
    requireUser,
    (req, res) => {
      const resolved = resolveSessionAccess(
        sessions,
        chat,
        String(req.params.id),
        req.user!,
      );
      if (!resolved) {
        return res.status(404).json({ error: 'code_session_not_found' });
      }
      const link = jiraTracking
        .listForSession(resolved.session.id)
        .find(item => item.id === String(req.params.linkId));
      if (!link) {
        return res.status(404).json({ error: 'jira_link_not_found' });
      }
      const removed = jiraTracking.remove(link.id, req.user!);
      events.publish({
        type: 'jiraLinks.updated',
        channelId: resolved.channel.id,
        payload: { sessionId: resolved.session.id, removed },
      });
      return res.json({ link: removed });
    },
  );

  router.get('/work-tracking/sessions', requireUser, (req, res) => {
    const visibleSessions = [...sessions.values()].filter(session =>
      chat.userCanAccessSession(session, req.user!),
    );
    const results = jiraTracking.searchSessions(
      visibleSessions,
      session => chat.getChannelForSession(session),
      {
        jiraKey: optionalQuery(req.query.jiraKey),
        teamId: optionalQuery(req.query.teamId),
        teamName: optionalQuery(req.query.teamName),
        projectKey: optionalQuery(req.query.projectKey),
        ownerEmail: optionalQuery(req.query.ownerEmail),
        memberEmail: optionalQuery(req.query.memberEmail),
        workspaceDir: optionalQuery(req.query.workspaceDir),
        source: optionalQuery(req.query.source) as
          | JiraSessionLinkSource
          | undefined,
        confidence: optionalQuery(req.query.confidence) as
          | JiraSessionLinkConfidence
          | undefined,
        createdAfter: optionalQuery(req.query.createdAfter),
        createdBefore: optionalQuery(req.query.createdBefore),
        includeArchived: req.query.includeArchived
          ? req.query.includeArchived !== 'false'
          : true,
        includeUntagged: req.user!.isSuperAdmin
          ? req.query.includeUntagged !== 'false'
          : req.query.includeUntagged === 'true',
      },
    );
    return res.json({
      sessions: results.map(result => ({
        ...result.session,
        channel: result.channel,
        jiraLinks: result.jiraLinks,
        jiraItems: result.jiraItems,
        teams: result.teams,
      })),
    });
  });

  router.get('/work-tracking/jira-items', requireUser, (req, res) => {
    const visibleSessionIds = new Set(
      [...sessions.values()]
        .filter(session => chat.userCanAccessSession(session, req.user!))
        .map(session => session.id),
    );
    const items = jiraTracking
      .searchJiraItems({
        sessionId: optionalQuery(req.query.sessionId),
        teamId: optionalQuery(req.query.teamId),
        teamName: optionalQuery(req.query.teamName),
        projectKey: optionalQuery(req.query.projectKey),
        createdAfter: optionalQuery(req.query.createdAfter),
        createdBefore: optionalQuery(req.query.createdBefore),
      })
      .map(item => ({
        ...item,
        links: item.links.filter(link => visibleSessionIds.has(link.sessionId)),
        sessionIds: item.sessionIds.filter(id => visibleSessionIds.has(id)),
      }))
      .filter(item => item.links.length > 0);
    return res.json({ items });
  });

  router.get('/work-tracking/jira-items/:key', requireUser, (req, res) => {
    const detail = jiraTracking.getJiraItemDetail(String(req.params.key));
    if (!detail) {
      return res.status(404).json({ error: 'jira_item_not_found' });
    }
    const visibleSessionIds = new Set(
      [...sessions.values()]
        .filter(session => chat.userCanAccessSession(session, req.user!))
        .map(session => session.id),
    );
    const links = detail.links.filter(link =>
      visibleSessionIds.has(link.sessionId),
    );
    if (links.length === 0) {
      return res.status(404).json({ error: 'jira_item_not_found' });
    }
    return res.json({
      item: detail.item,
      key: detail.key,
      firstSeenAt: links[0]?.createdAt,
      lastSeenAt: links.at(-1)?.createdAt,
      sourceCounts: countLinkSources(links),
      integrationFormat: detail.integrationFormat,
      links,
      sessions: unique(links.map(link => link.sessionId))
        .map(id => sessions.get(id))
        .filter((session): session is CodeSession => Boolean(session))
        .map(session => ({
          ...session,
          role: session.ownerEmail === req.user!.email ? 'owner' : 'member',
          channel: chat.getChannelForSession(session),
        })),
    });
  });

  router.get('/work-tracking/teams', requireUser, (req, res) => {
    const visibleSessionIds = new Set(
      [...sessions.values()]
        .filter(session => chat.userCanAccessSession(session, req.user!))
        .map(session => session.id),
    );
    const teams = jiraTracking
      .searchTeams({
        sessionId: optionalQuery(req.query.sessionId),
        jiraKey: optionalQuery(req.query.jiraKey),
        projectKey: optionalQuery(req.query.projectKey),
        memberEmail: optionalQuery(req.query.memberEmail),
        createdAfter: optionalQuery(req.query.createdAfter),
        createdBefore: optionalQuery(req.query.createdBefore),
      })
      .map(team => ({
        ...team,
        links: team.links.filter(link => visibleSessionIds.has(link.sessionId)),
        sessionIds: team.sessionIds.filter(id => visibleSessionIds.has(id)),
      }))
      .filter(team => team.links.length > 0);
    return res.json({ teams });
  });

  return router;
}

export function runtimeWorkbenchRouter(
  config: AppConfig,
  sessions: SessionStore,
  chat: ChatStore,
): express.Router {
  const router = express.Router();
  const launcher = new SessionLauncher(config);
  const events = new ChatEventHub(chat);
  const slack = new SlackClient(config);

  router.post(
    '/code/sessions',
    requireInternalToken(config, ['session']),
    async (_req, res, next) => {
      try {
        const token = res.locals.internalToken as VerifiedInternalToken;
        const result = await launchCodeSessionForUser({
          sessions,
          chat,
          slack,
          events,
          launcher,
          user: userFromInternalToken(token),
        });
        return res.status(result.existing ? 200 : 201).json({
          session: result.session,
          channel: result.channel,
        });
      } catch (error) {
        return next(error);
      }
    },
  );

  router.get(
    '/code/sessions',
    requireInternalToken(config, ['session']),
    async (_req, res, next) => {
      try {
        const token = res.locals.internalToken as VerifiedInternalToken;
        const user = userFromInternalToken(token);
        await ensureOwnedSessionsRunning(sessions, chat, launcher, user);
        await refreshVisibleSessionNames(sessions, chat, user);
        return res.json({
          sessions: visibleCodeSessionViews(sessions, chat, user),
        });
      } catch (error) {
        return next(error);
      }
    },
  );

  router.delete(
    '/code/sessions/:id',
    requireInternalToken(config, ['session']),
    (req, res) => {
      const token = res.locals.internalToken as VerifiedInternalToken;
      const user = userFromInternalToken(token);
      const session = sessions.get(String(req.params.id));
      if (!session || session.ownerEmail !== user.email) {
        return res.status(404).json({ error: 'code_session_not_found' });
      }
      const channel = chat.archiveSessionChannel(session);
      sessions.delete(session.id);
      events.publish({
        type: 'session.archived',
        channelId: channel?.id ?? `session-${session.id}`,
        payload: { session, channel },
      });
      return res.json({ session, channel });
    },
  );

  return router;
}

export function memoryRouter(
  config: AppConfig,
  memory: MemoryStore | undefined,
): express.Router {
  const router = express.Router();

  router.post(
    '/entries',
    requireInternalToken(config, ['memory:write']),
    async (req, res, next) => {
      try {
        const store = requireMemoryStore(memory, res);
        if (!store) {
          return;
        }
        const body = z
          .object({
            content: z.string().min(1),
            title: z.string().min(1).optional(),
            kind: z
              .enum(['thought', 'finding', 'decision', 'document', 'chunk'])
              .default('thought'),
            scope: z.enum(['personal', 'team', 'global']).default('team'),
            project: z.string().min(1).optional(),
            repo: z.string().min(1).optional(),
            sourceSystem: z.string().min(1).optional(),
            sourceSessionId: z.string().min(1).optional(),
            toolName: z.string().min(1).optional(),
            author: z.enum(['user', 'agent']).default('user'),
            tags: z.array(z.string().min(1)).default([]),
            meta: z.record(z.string(), z.unknown()).default({}),
          })
          .parse(req.body);
        const token = res.locals.internalToken as VerifiedInternalToken;
        const entry = await store.captureEntry({
          ownerId: token.ownerEmail,
          identitySubject: token.subject,
          content: body.content,
          title: body.title,
          kind: body.kind as MemoryEntryKind,
          scope: body.scope as MemoryEntryScope,
          project: body.project,
          repo: body.repo,
          sourceSystem: body.sourceSystem,
          sourceSessionId: body.sourceSessionId,
          toolName: body.toolName,
          author: body.author as MemoryEntryAuthor,
          tags: body.tags,
          meta: body.meta,
        });
        res.status(201).json({ entry });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/entries',
    requireInternalToken(config, ['memory:read']),
    async (req, res, next) => {
      try {
        const store = requireMemoryStore(memory, res);
        if (!store) {
          return;
        }
        const query = z
          .object({
            q: z.string().min(1).optional(),
            limit: z.coerce.number().int().positive().max(50).default(10),
            project: z.string().min(1).optional(),
            scope: z.enum(['personal', 'team', 'global']).optional(),
            repo: z.string().min(1).optional(),
            includePending: queryBoolean().default(false),
          })
          .parse(req.query);
        const token = res.locals.internalToken as VerifiedInternalToken;
        const entries = await store.searchEntries({
          ownerId: token.ownerEmail,
          identitySubject: token.subject,
          query: query.q,
          limit: query.limit,
          project: query.project,
          scope: query.scope as MemoryEntryScope | undefined,
          repo: query.repo,
          includePending: query.includePending,
        });
        res.json({ entries });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}

function requireInternalToken(
  config: AppConfig,
  scopes: InternalTokenScope[],
): express.RequestHandler {
  return async (req, res, next) => {
    try {
      const token = bearerToken(req.header('authorization'));
      if (!token) {
        return res.status(401).json({ error: 'missing_bearer_token' });
      }
      res.locals.internalToken = await verifyInternalToken(
        token,
        config.OPENCORTEX_INTERNAL_TOKEN_SECRET,
        scopes,
      );
      return next();
    } catch (error) {
      return res.status(403).json({
        error: 'invalid_internal_token',
        message: error instanceof Error ? error.message : 'Unknown auth error',
      });
    }
  };
}

function bearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] ?? null;
}

function requireMemoryStore(
  memory: MemoryStore | undefined,
  res: express.Response,
): MemoryStore | undefined {
  if (memory) {
    return memory;
  }
  res.status(503).json({
    error: 'memory_unavailable',
    message: 'OPENCORTEX_MEMORY_DATABASE_URL is not configured.',
  });
  return undefined;
}

function requireWorkflowProjectionStore(
  workflowProjections: WorkflowProjectionStore | undefined,
  res: express.Response,
): WorkflowProjectionStore | undefined {
  if (workflowProjections) {
    return workflowProjections;
  }
  res.status(503).json({
    error: 'workflow_projection_unavailable',
    message: 'OPENCORTEX_MEMORY_DATABASE_URL is not configured.',
  });
  return undefined;
}

async function workbenchSessionStartProjection(
  workflowProjections: WorkflowProjectionStore | undefined,
  workflow: WorkbenchSessionWorkflowStart,
  user: AuthenticatedUser,
): Promise<WorkflowProjection> {
  const stored = await workflowProjections?.get(workflow.workflowId, {
    ownerId: user.email,
    isSuperAdmin: Boolean(user.isSuperAdmin),
  });
  if (stored) {
    return stored;
  }
  const timestamp = new Date().toISOString();
  return {
    workflowId: workflow.workflowId,
    runId: workflow.runId,
    workflowType: 'WorkbenchSessionWorkflow',
    status: 'running',
    ownerId: user.email,
    entryIds: [],
    summary: `WorkbenchSessionWorkflow started for ${user.email}`,
    data: {
      pendingProjectionWrite: true,
    },
    startedAt: timestamp,
    updatedAt: timestamp,
  };
}

async function workbenchSessionProjectionForSession(
  workflowProjections: WorkflowProjectionStore | undefined,
  session: CodeSession,
  user: AuthenticatedUser,
): Promise<WorkflowProjection | undefined> {
  const projections = await workflowProjections?.list({
    ownerId: session.ownerEmail,
    isSuperAdmin: Boolean(user.isSuperAdmin),
    workflowType: 'WorkbenchSessionWorkflow',
    status: 'running',
    sourceSystem: 'opencortex-runtime',
    sourceSessionId: session.id,
    limit: 1,
  });
  return projections?.[0];
}

async function attachIssuesToWorkbenchWorkflow(params: {
  workflowProjections: WorkflowProjectionStore | undefined;
  issueAttacher: WorkbenchSessionWorkflowIssueAttacher;
  config: AppConfig;
  session: CodeSession;
  user: AuthenticatedUser;
  links: Array<{ kind: string; targetKey?: string; targetUrl?: string }>;
}): Promise<WorkbenchSessionWorkflowSignal[]> {
  const issueLinks = params.links.filter(
    link => link.kind === 'issue' && link.targetKey,
  );
  if (issueLinks.length === 0) {
    return [];
  }
  const projection = await workbenchSessionProjectionForSession(
    params.workflowProjections,
    params.session,
    params.user,
  );
  if (!projection) {
    return [];
  }
  const signals: WorkbenchSessionWorkflowSignal[] = [];
  for (const link of issueLinks) {
    signals.push(await params.issueAttacher(params.config, projection.workflowId, {
      issueKey: link.targetKey!,
      url: link.targetUrl,
    }));
  }
  return signals;
}

async function sendPairPromptToWorkbenchWorkflow(params: {
  workflowProjections: WorkflowProjectionStore | undefined;
  pairPromptSender: WorkbenchSessionWorkflowPairPromptSender;
  config: AppConfig;
  session: CodeSession;
  user: AuthenticatedUser;
  prompt: string;
  threadId?: string;
}): Promise<WorkbenchSessionWorkflowSignal | undefined> {
  const projection = await workbenchSessionProjectionForSession(
    params.workflowProjections,
    params.session,
    params.user,
  );
  if (!projection) {
    return undefined;
  }
  return params.pairPromptSender(params.config, projection.workflowId, {
    prompt: params.prompt,
    threadId: params.threadId,
  });
}

function optionalQuery(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function queryBoolean() {
  return z.preprocess(value => {
    if (value === undefined) {
      return undefined;
    }
    if (value === 'true') {
      return true;
    }
    if (value === 'false') {
      return false;
    }
    return value;
  }, z.boolean());
}

function messageLimit(value: unknown): number {
  return value === 'all' ? Number.POSITIVE_INFINITY : Number(value ?? 100);
}

function countLinkSources(
  links: Array<{ source: JiraSessionLinkSource }>,
): Partial<Record<JiraSessionLinkSource, number>> {
  const counts: Partial<Record<JiraSessionLinkSource, number>> = {};
  for (const link of links) {
    counts[link.source] = (counts[link.source] ?? 0) + 1;
  }
  return counts;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function sessionForChannel(
  sessions: SessionStore,
  chat: ChatStore,
  channelId: string,
): { session: CodeSession; channel: ChatChannel } | undefined {
  for (const session of sessions.values()) {
    const channel = chat
      .listLiveSessionChannels(session)
      .find(item => item.id === channelId);
    if (channel?.id === channelId) {
      const thread = (session.threads ?? []).find(
        item => item.id === channel.session?.threadId,
      );
      return {
        session: thread ? sessionWithSelectedThread(session, thread) : session,
        channel,
      };
    }
  }
  return undefined;
}

type CodeSessionView = CodeSession & { channel: ChatChannel };

function visibleCodeSessionViews(
  sessions: SessionStore,
  chat: ChatStore,
  user: AuthenticatedUser,
): CodeSessionView[] {
  const views: CodeSessionView[] = [];
  for (const session of sessions.values()) {
    if (!chat.userCanAccessSession(session, user)) {
      continue;
    }
    const sessionChannels = chat
      .listChannelsForUser(user)
      .filter(
        channel =>
          channel.type === 'session' &&
          !channel.archivedAt &&
          channel.session?.sessionId === session.id,
      );
    if (sessionChannels.length === 0) {
      const channel = chat.getChannelForSession(session);
      if (channel && !channel.archivedAt) {
        views.push({ ...session, channel });
      }
      continue;
    }
    for (const channel of sessionChannels) {
      const thread = codeThreadForChannel(session, channel);
      const view = thread
        ? sessionWithSelectedThread(session, thread)
        : session;
      views.push({ ...view, channel });
    }
  }
  return views.sort((a, b) => {
    const aTime = a.channel.lastMessageAt ?? a.channel.createdAt;
    const bTime = b.channel.lastMessageAt ?? b.channel.createdAt;
    return bTime.localeCompare(aTime);
  });
}

function codeThreadForChannel(
  session: CodeSession,
  channel: ChatChannel,
): CodeThread | undefined {
  const threadId = channel.session?.threadId;
  if (threadId) {
    return session.threads?.find(thread => thread.id === threadId);
  }
  const openCodeSessionId = channel.session?.openCodeSessionId;
  if (openCodeSessionId) {
    return session.threads?.find(
      thread => thread.openCodeSessionId === openCodeSessionId,
    );
  }
  return activeCodeThread(session);
}

function sessionWithSelectedThread(
  session: CodeSession,
  thread: CodeThread,
): CodeSession {
  return {
    ...session,
    openCodeSessionId: thread.openCodeSessionId,
    activeThreadId: thread.id,
    name: thread.name ?? session.name,
    workspaceDir: thread.workspaceDir ?? session.workspaceDir,
  };
}

function sessionWithThreadWorkspace(
  session: CodeSession,
  workspaceDir: string,
): CodeSession {
  const activeThread = activeCodeThread(session);
  if (!activeThread || activeThread.workspaceDir === workspaceDir) {
    return session;
  }
  const threads = (session.threads ?? []).map(thread =>
    thread.id === activeThread.id ? { ...thread, workspaceDir } : thread,
  );
  return {
    ...session,
    threads,
  };
}

function resolveSessionAccess(
  sessions: SessionStore,
  chat: ChatStore,
  sessionId: string,
  user: AuthenticatedUser,
): { session: CodeSession; channel: ChatChannel } | undefined {
  const session = sessions.get(sessionId);
  if (!session || !chat.userCanAccessSession(session, user)) {
    return undefined;
  }
  const channel = chat.getChannelForSession(session);
  if (!channel) {
    return undefined;
  }
  return { session, channel };
}

function resolveDraftAccess(
  sessions: SessionStore,
  chat: ChatStore,
  pairPrompts: PairPromptStore,
  sessionId: string,
  draftId: string,
  user: AuthenticatedUser,
):
  | { session: CodeSession; channel: ChatChannel; draft: PairPromptDraft }
  | undefined {
  const resolved = resolveSessionAccess(sessions, chat, sessionId, user);
  if (!resolved) {
    return undefined;
  }
  const draft = pairPrompts.get(draftId);
  if (!draft || draft.sessionId !== resolved.session.id) {
    return undefined;
  }
  return { ...resolved, draft };
}

async function publishPairPromptEvent(
  chat: ChatStore,
  events: ChatEventHub,
  channelId: string,
  input: {
    type:
      | 'pairPrompt.created'
      | 'pairPrompt.ready'
      | 'pairPrompt.reopened'
      | 'pairPrompt.rejected'
      | 'pairPrompt.sending'
      | 'pairPrompt.sent'
      | 'pairPrompt.failed';
    body: string;
    draft: unknown;
  },
): Promise<void> {
  const message = await chat.appendSystemMessage(channelId, input.body, {
    pairPrompt: input.draft,
  });
  events.publish({
    type: input.type,
    channelId,
    payload: { draft: input.draft },
  });
  events.publish({
    type: 'message.created',
    channelId,
    payload: { message },
  });
}

async function ensureSlackSessionBinding(
  slack: SlackClient,
  chat: ChatStore,
  session: CodeSession,
  channel: ChatChannel,
): Promise<ChatChannel> {
  const slackChannel = await slack.ensureSessionChannel(session, channel);
  if (!slackChannel) {
    return channel;
  }
  return chat.attachSlackChannel(channel.id, slackChannel);
}

async function reusableWorkspaceSession(
  sessions: SessionStore,
  launcher: SessionLauncher,
  user: AuthenticatedUser,
): Promise<CodeSession | undefined> {
  const session = sessions.findByOwnerEmail(user.email);
  if (!session) {
    return undefined;
  }
  if (session.mode === 'dry-run' || (await isSessionRestorable(session))) {
    const normalized = sessionWithActiveThread(session);
    if (normalized !== session) {
      sessions.set(normalized.id, normalized);
    }
    return normalized;
  }
  return relaunchSession(sessions, launcher, session);
}

async function launchCodeSessionForUser(params: {
  sessions: SessionStore;
  chat: ChatStore;
  slack: SlackClient;
  events: ChatEventHub;
  launcher: SessionLauncher;
  user: AuthenticatedUser;
}): Promise<{ session: CodeSession; channel: ChatChannel; existing: boolean }> {
  const existing = await reusableWorkspaceSession(
    params.sessions,
    params.launcher,
    params.user,
  );
  const session = existing ?? (await params.launcher.launch(params.user));
  params.sessions.set(session.id, session);
  const channel = params.chat.ensureSessionChannel(session, params.user);
  const updatedChannel = await ensureSlackSessionBinding(
    params.slack,
    params.chat,
    session,
    channel,
  );
  params.events.publish({
    type: 'session.started',
    channelId: updatedChannel.id,
    payload: { session, channel: updatedChannel },
  });
  return {
    session,
    channel: updatedChannel,
    existing: Boolean(existing),
  };
}

async function ensureOwnedSessionsRunning(
  sessions: SessionStore,
  chat: ChatStore,
  launcher: SessionLauncher,
  user: AuthenticatedUser,
): Promise<void> {
  const owned = [...sessions.values()].filter(
    session => session.ownerEmail === user.email,
  );
  await Promise.all(
    owned.map(async session => {
      const running =
        session.mode === 'dry-run' || (await isSessionRestorable(session));
      if (running) {
        return;
      }
      const relaunched = await relaunchSession(sessions, launcher, session);
      chat.ensureSessionChannel(relaunched, userFromSessionOwner(relaunched));
    }),
  );
}

async function relaunchSession(
  sessions: SessionStore,
  launcher: SessionLauncher,
  session: CodeSession,
): Promise<CodeSession> {
  const relaunched = await launcher.launch(userFromSessionOwner(session));
  const restored: CodeSession = {
    ...relaunched,
    createdAt: session.createdAt,
  };
  sessions.set(restored.id, restored);
  return restored;
}

async function refreshVisibleSessionNames(
  sessions: SessionStore,
  chat: ChatStore,
  user: AuthenticatedUser,
): Promise<void> {
  const visible = [...sessions.values()].filter(session =>
    chat.userCanAccessSession(session, user),
  );
  await Promise.all(
    visible.map(async session => {
      const synced = await syncOpenCodeSessionInventory(
        sessions,
        chat,
        session,
      );
      if (synced) {
        return;
      }
      chat.archiveSessionChannelsNotMatchingThreads(session);
      const threads = session.threads?.length
        ? session.threads
        : activeCodeThread(session)
          ? [activeCodeThread(session)!]
          : [];
      if (threads.length === 0) {
        chat.updateSessionChannelName(session);
        return;
      }

      let changed = false;
      await Promise.all(
        threads.map(async thread => {
          const name = await fetchOpenCodeSessionNameById(
            session,
            thread.openCodeSessionId,
          ).catch(() => undefined);
          if (name === undefined || thread.name === name) {
            return;
          }
          thread.name = name;
          changed = true;
        }),
      );

      const active = activeCodeThread(session);
      if (active?.name && session.name !== active.name) {
        session.name = active.name;
        changed = true;
      }

      if (changed) {
        sessions.set(session.id, session);
        for (const thread of threads) {
          chat.updateSessionChannelName(
            sessionWithSelectedThread(session, thread),
          );
        }
      }
    }),
  );
}

async function syncOpenCodeSessionInventory(
  sessions: SessionStore,
  chat: ChatStore,
  session: CodeSession,
): Promise<boolean> {
  const summaries = await fetchOpenCodeSessions(session).catch(() => undefined);
  if (!summaries || summaries.length === 0) {
    return false;
  }

  const existingByOpenCodeId = new Map(
    (session.threads ?? []).map(thread => [thread.openCodeSessionId, thread]),
  );
  const now = new Date().toISOString();
  const threads = summaries.map(summary => {
    const existing = existingByOpenCodeId.get(summary.id);
    return {
      id: existing?.id ?? threadIdForOpenCodeSession(summary.id),
      openCodeSessionId: summary.id,
      ...(summary.name
        ? { name: summary.name }
        : existing?.name
          ? { name: existing.name }
          : {}),
      ...(summary.workspaceDir
        ? { workspaceDir: summary.workspaceDir }
        : existing?.workspaceDir
          ? { workspaceDir: existing.workspaceDir }
          : {}),
      createdAt: existing?.createdAt ?? now,
      lastSelectedAt: existing?.lastSelectedAt ?? now,
    } satisfies CodeThread;
  });
  const activeThread =
    threads.find(
      thread => thread.openCodeSessionId === session.openCodeSessionId,
    ) ??
    threads.find(thread => thread.id === session.activeThreadId) ??
    threads[0];
  const normalized: CodeSession = {
    ...session,
    openCodeSessionId: activeThread.openCodeSessionId,
    activeThreadId: activeThread.id,
    name: activeThread.name,
    threads,
  };
  sessions.set(normalized.id, normalized);

  const owner = userFromSessionOwner(normalized);
  for (const thread of threads) {
    const threadSession = sessionWithSelectedThread(normalized, thread);
    chat.ensureSessionChannel(threadSession, owner);
    chat.updateSessionThreadChannelName(threadSession, thread);
  }
  chat.archiveSessionChannelsNotMatchingThreads(normalized);
  return true;
}

function threadIdForOpenCodeSession(openCodeSessionId: string): string {
  const safe = openCodeSessionId.replace(/[^a-zA-Z0-9._-]/g, '-');
  return `thread-${safe || 'session'}`;
}

function userFromSessionOwner(session: CodeSession): AuthenticatedUser {
  return {
    sub: `session-owner:${session.ownerEmail}`,
    email: session.ownerEmail,
    groups: [],
    linuxUser: session.linuxUser,
  };
}

function userFromInternalToken(token: VerifiedInternalToken): AuthenticatedUser {
  return {
    sub: token.subject,
    email: token.ownerEmail,
    groups: [],
    linuxUser: token.linuxUser,
  };
}

async function inviteSlackMember(
  slack: SlackClient,
  chat: ChatStore,
  channel: ChatChannel,
  email: string,
): Promise<void> {
  const slackChannelId = channel.external?.slack?.channelId;
  if (!slackChannelId) {
    return;
  }
  try {
    await slack.inviteEmail(slackChannelId, email);
  } catch (error) {
    await chat.appendSystemMessage(
      channel.id,
      `Slack invite for ${email} failed: ${errorMessage(error)}`,
      { slackInviteFailedFor: email },
    );
  }
}

async function mirrorMessageToSlack(
  slack: SlackClient,
  channel: ChatChannel | undefined,
  message: { authorEmail: string; body: string; kind: string },
): Promise<void> {
  const slackChannelId = channel?.external?.slack?.channelId;
  if (!slackChannelId || message.kind !== 'user') {
    return;
  }
  await slack.postMessage(
    slackChannelId,
    `${message.authorEmail}: ${message.body}`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

export function codeSessionProxy(
  config: AppConfig,
  sessions: SessionStore,
  chat: ChatStore,
): express.Router {
  const router = express.Router();
  const proxy = httpProxy.createProxyServer({ selfHandleResponse: true });
  const launcher = new SessionLauncher(config);

  proxy.on('error', (error, _req, res) => {
    if ('writeHead' in res) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'opencode_proxy_error',
          message: error.message,
        }),
      );
    }
  });

  proxy.on('proxyRes', (proxyRes, req, res) => {
    const contentType = proxyRes.headers['content-type'] ?? '';
    const rewritable = isRebrandableBrowserAsset(String(contentType));
    if (!rewritable) {
      res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
      proxyRes.pipe(res);
      return;
    }

    const chunks: Buffer[] = [];
    proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
    proxyRes.on('end', () => {
      const sessionBase =
        (req as express.Request & { opencortexSessionBase?: string })
          .opencortexSessionBase ?? '/';
      let body = Buffer.concat(chunks).toString('utf8');
      if (String(contentType).includes('text/html')) {
        // Inject a <base href> so the OpenCode SPA resolves its relative asset
        // chunks (./assets/*.js) and derives its API/SSE server base (via
        // document.baseURI, see the fork's entry.tsx) under the session path
        // prefix. This is the load-bearing rewrite; the SPA uses root-relative
        // and relative URLs at runtime that a bare attribute rewrite cannot
        // reach (dynamic imports, fetch, EventSource).
        const baseTag = `<base href="${sessionBase}">`;
        body = body.includes('<base ')
          ? body.replace(/<base\s+href="[^"]*"\s*\/?>/i, baseTag)
          : body.replace(/<head(\s[^>]*)?>/i, match => `${match}${baseTag}`);
        body = injectSessionAddon(body, req as express.Request);
      }
      body = rebrandEmbeddedCodeUi(body);

      const headers = { ...proxyRes.headers };
      delete headers['content-length'];
      delete headers.etag;
      res.writeHead(proxyRes.statusCode ?? 200, headers);
      res.end(body);
    });
  });

  router.use('/:id', async (req, res) => {
    let session = sessions.get(String(req.params.id));
    if (
      !session ||
      !req.user ||
      !chat.userCanAccessSession(session, req.user)
    ) {
      return res.status(404).json({ error: 'code_session_not_found' });
    }

    if (session.mode !== 'dry-run' && !(await isSessionRestorable(session))) {
      try {
        session = await relaunchSession(sessions, launcher, session);
      } catch (error) {
        return res.status(502).json({
          error: 'code_session_relaunch_failed',
          message: errorMessage(error),
        });
      }
    }

    // Express has already stripped the "/:id" segment from req.url, so the
    // OpenCode backend receives root-relative paths (/skill, /assets/x.js, /)
    // exactly as it expects — no further prefix stripping required here.
    const selectedOpenCodeSessionId = openCodeSessionIdFromProxyUrl(req.url);
    const selectedWorkspaceDir = workspaceDirFromProxyUrl(req.url);
    let requestThread = selectedOpenCodeSessionId
      ? session.threads?.find(
          thread => thread.openCodeSessionId === selectedOpenCodeSessionId,
        )
      : undefined;
    let shouldPersistSession = false;
    if (selectedOpenCodeSessionId) {
      const now = new Date().toISOString();
      requestThread = {
        id:
          requestThread?.id ??
          threadIdForOpenCodeSession(selectedOpenCodeSessionId),
        openCodeSessionId: selectedOpenCodeSessionId,
        ...(requestThread?.name ? { name: requestThread.name } : {}),
        workspaceDir:
          selectedWorkspaceDir ??
          requestThread?.workspaceDir ??
          session.workspaceDir,
        createdAt: requestThread?.createdAt ?? now,
        lastSelectedAt: now,
      };
      if (
        !session.threads?.some(thread => thread.id === requestThread?.id) ||
        (selectedWorkspaceDir &&
          session.threads?.some(
            thread =>
              thread.id === requestThread?.id &&
              thread.workspaceDir !== selectedWorkspaceDir,
          ))
      ) {
        const threads = [
          ...(session.threads ?? []).filter(
            thread => thread.id !== requestThread?.id,
          ),
          requestThread,
        ];
        session = {
          ...session,
          threads,
        };
        shouldPersistSession = true;
      }
    } else if (selectedWorkspaceDir) {
      session = sessionWithThreadWorkspace(session, selectedWorkspaceDir);
      requestThread = activeCodeThread(session);
      shouldPersistSession = true;
    }
    if (shouldPersistSession) {
      sessions.set(session.id, session);
    }
    const requestSession = requestThread
      ? sessionWithSelectedThread(session, requestThread)
      : session;
    chat.ensureSessionChannel(requestSession, req.user);
    (
      req as express.Request & { opencortexSessionBase?: string }
    ).opencortexSessionBase = requestSession.urlPath;
    (
      req as express.Request & { opencortexSessionAddon?: SessionAddon }
    ).opencortexSessionAddon = sessionAddon(requestSession, chat);
    return proxy.web(req, res, {
      target: `http://127.0.0.1:${requestSession.port}`,
      changeOrigin: false,
    });
  });

  return router;
}

export function rawOpenCodeSessionRedirect(
  sessions: SessionStore,
  chat: ChatStore,
): express.RequestHandler {
  return (req, res) => {
    if (!req.user) {
      return res.status(404).json({ error: 'code_session_not_found' });
    }
    const openCodeSessionId = String(req.params.openCodeSessionId ?? '');
    const workspaceToken = String(req.params.workspace ?? '');
    const workspaceDir = workspaceDirFromToken(workspaceToken);
    if (!openCodeSessionId || !workspaceDir) {
      return res.status(404).json({ error: 'code_session_not_found' });
    }

    for (const session of sessions.values()) {
      if (!chat.userCanAccessSession(session, req.user)) {
        continue;
      }
      const matchingThread = (session.threads ?? []).find(
        thread =>
          thread.openCodeSessionId === openCodeSessionId &&
          (!thread.workspaceDir || thread.workspaceDir === workspaceDir),
      );
      const legacyMatch =
        session.openCodeSessionId === openCodeSessionId &&
        session.workspaceDir === workspaceDir;
      if (!matchingThread && !legacyMatch) {
        continue;
      }
      const token = encodeURIComponent(workspaceToken);
      const id = encodeURIComponent(openCodeSessionId);
      return res.redirect(302, `${session.urlPath}${token}/session/${id}`);
    }

    return res.status(404).json({ error: 'code_session_not_found' });
  };
}

function openCodeSessionIdFromProxyUrl(url: string): string | undefined {
  const match = url.match(/(?:^|\/)session\/([^/?#]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

function workspaceDirFromProxyUrl(url: string): string | undefined {
  const match = url.match(/^\/([^/?#]+)(?:\/|$)/);
  if (!match?.[1] || match[1] === 'session') {
    return undefined;
  }
  return workspaceDirFromToken(match[1]);
}

function workspaceDirFromToken(token: string): string | undefined {
  try {
    const decoded = base64UrlDecode(token);
    return decoded.startsWith('/') ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function base64UrlDecode(value: string): string {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    '=',
  );
  return Buffer.from(padded, 'base64').toString('utf8');
}

function isRebrandableBrowserAsset(contentType: string): boolean {
  return (
    contentType.includes('text/html') ||
    contentType.includes('application/javascript') ||
    contentType.includes('text/javascript')
  );
}

function rebrandEmbeddedCodeUi(body: string): string {
  return body.replaceAll('OpenCode', 'OpenCortex Workbench');
}

interface SessionAddon {
  apiBaseUrl: string;
  channelId?: string;
  channelName: string;
  workbenchUrl: string;
  slackUrl?: string;
}

function sessionAddon(session: CodeSession, chat: ChatStore): SessionAddon {
  const channel = chat.getChannelForSession(session);
  return {
    apiBaseUrl: `${sessionBasePath(session)}/api`,
    channelId: channel?.id,
    channelName: channel?.name ?? session.name ?? 'New session',
    workbenchUrl: sessionShellUrl(session),
    ...(channel?.external?.slack?.url
      ? { slackUrl: channel.external.slack.url }
      : {}),
  };
}

function sessionShellUrl(session: CodeSession): string {
  return `${sessionBasePath(session)}/code/sessions/${encodeURIComponent(session.id)}`;
}

function sessionBasePath(session: CodeSession): string {
  const marker = '/code/session/';
  const markerIndex = session.urlPath.indexOf(marker);
  return markerIndex >= 0 ? session.urlPath.slice(0, markerIndex) : '';
}

function injectSessionAddon(body: string, req: express.Request): string {
  const addon = (
    req as express.Request & { opencortexSessionAddon?: SessionAddon }
  ).opencortexSessionAddon;
  if (
    !addon ||
    body.includes('data-opencortex-session-addon') ||
    body.includes('data-diwan-session-addon')
  ) {
    return body;
  }
  const html = sessionAddonHtml(addon);
  return /<\/body>/i.test(body)
    ? body.replace(/<\/body>/i, match => `${html}${match}`)
    : `${body}${html}`;
}

function sessionAddonHtml(addon: SessionAddon): string {
  return [
    '<div data-opencortex-session-addon',
    ` data-api-base-url="${escapeHtml(addon.apiBaseUrl)}"`,
    addon.channelId ? ` data-channel-id="${escapeHtml(addon.channelId)}"` : '',
    ` data-channel-name="${escapeHtml(addon.channelName)}"`,
    ` data-workbench-url="${escapeHtml(addon.workbenchUrl)}"`,
    addon.slackUrl ? ` data-slack-url="${escapeHtml(addon.slackUrl)}"` : '',
    '></div>',
    `<script src="${escapeHtml(addon.apiBaseUrl.replace(/\/api$/, ''))}/opencortex-session-addon.js" defer></script>`,
  ].join('');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
