import { readFileSync } from 'node:fs';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import type { AppConfig } from '../config/config.js';
import { oidcAuth } from '../auth/oidc.js';
import {
  apiRouter,
  codeSessionProxy,
  memoryRouter,
  publicRouter,
  rawOpenCodeSessionRedirect,
  runtimeWorkbenchRouter,
  type PairPromptWorkflowStarter,
  type PairPromptResponseSignaler,
  type ReviewWorkflowStarter,
  type WorkbenchSessionWorkflowArchiver,
  type WorkbenchSessionWorkflowIssueAttacher,
  type WorkbenchSessionWorkflowPairPromptSender,
  type WorkbenchSessionWorkflowStarter,
} from './routes.js';
import { SessionStore } from '../code/sessionStore.js';
import { ChatStore } from '../chat/chatStore.js';
import { PairPromptStore } from '../pairPrompts/pairPromptStore.js';
import { JiraTrackingStore } from '../jira/jiraTrackingStore.js';
import { createMemoryStore, type MemoryStore } from '../memory/memoryStore.js';
import {
  createWorkflowProjectionStore,
  type WorkflowProjectionStore,
} from '../workflows/workflowProjectionStore.js';
import { RuntimeMetrics, runtimeMetricsMiddleware } from './metrics.js';

export function createApp(
  config: AppConfig,
  codeSessions: SessionStore = new SessionStore(config.OPENCORTEX_DATA_DIR),
  chat: ChatStore = new ChatStore(config),
  pairPrompts: PairPromptStore = new PairPromptStore(config.OPENCORTEX_DATA_DIR),
  jiraTracking: JiraTrackingStore = new JiraTrackingStore(
    config.OPENCORTEX_DATA_DIR,
  ),
  memory: MemoryStore | undefined = createMemoryStore(config),
  workflowProjections: WorkflowProjectionStore | undefined =
    createWorkflowProjectionStore(config),
  workbenchSessionWorkflowStarter?: WorkbenchSessionWorkflowStarter,
  workbenchSessionWorkflowArchiver?: WorkbenchSessionWorkflowArchiver,
  workbenchSessionWorkflowIssueAttacher?: WorkbenchSessionWorkflowIssueAttacher,
  workbenchSessionWorkflowPairPromptSender?: WorkbenchSessionWorkflowPairPromptSender,
  reviewWorkflowStarter?: ReviewWorkflowStarter,
  pairPromptWorkflowStarter?: PairPromptWorkflowStarter,
  pairPromptResponseSignaler?: PairPromptResponseSignaler,
): express.Express {
  const app = express();
  const mountPath = config.OPENCORTEX_BASE_PATH || '/';
  const metrics = new RuntimeMetrics();
  const publicDir = new URL('../ui/public', import.meta.url).pathname;
  const indexPath = new URL('../ui/public/index.html', import.meta.url)
    .pathname;
  const indexHtml = readFileSync(indexPath, 'utf8').replace(
    '%OPENCORTEX_BASE_HREF%',
    baseHref(mountPath),
  );

  app.use(helmet());
  app.use(runtimeMetricsMiddleware(metrics));
  // Parse JSON bodies for OpenCortex API, but NOT for the OpenCode session
  // proxy. http-proxy streams the raw request body to the backend; if
  // express.json() drains it first, proxied POSTs (e.g. the chat prompt_async)
  // hang waiting for a body that never arrives and abort after the timeout.
  const sessionProxyPrefix = `${mountPath === '/' ? '' : mountPath.replace(/\/$/, '')}/code/session/`;
  const jsonParser = express.json({ limit: '1mb' });
  app.use((req, res, next) => {
    if (req.path.startsWith(sessionProxyPrefix)) {
      return next();
    }
    return jsonParser(req, res, next);
  });
  app.use(cookieParser());
  app.use(pinoHttp());

  const mounted = express.Router();
  mounted.use('/api/health', (_req, res) =>
    res.json({ ok: true, service: 'opencortex-runtime' }),
  );
  mounted.get('/api/metrics', async (_req, res) =>
    res
      .type('text/plain; version=0.0.4')
      .send(metrics.render(codeSessions, await workflowProjections?.metrics?.())),
  );
  mounted.use('/api', publicRouter(config));
  mounted.use('/api/memory', memoryRouter(config, memory, reviewWorkflowStarter));
  mounted.use(
    '/api/runtime',
    runtimeWorkbenchRouter(config, codeSessions, chat, pairPrompts),
  );
  mounted.use(
    '/api',
    oidcAuth(config),
    apiRouter(
      config,
      codeSessions,
      chat,
      pairPrompts,
      jiraTracking,
      undefined,
      workflowProjections,
      workbenchSessionWorkflowStarter,
      workbenchSessionWorkflowArchiver,
      workbenchSessionWorkflowIssueAttacher,
      workbenchSessionWorkflowPairPromptSender,
      pairPromptWorkflowStarter,
      pairPromptResponseSignaler,
    ),
  );
  mounted.use(
    '/code/session',
    oidcAuth(config),
    codeSessionProxy(config, codeSessions, chat),
  );
  mounted.get(
    '/:workspace/session/:openCodeSessionId',
    oidcAuth(config),
    rawOpenCodeSessionRedirect(codeSessions, chat),
  );
  mounted.get('/', (_req, res) => res.type('html').send(indexHtml));
  mounted.get('/profile', (_req, res) => res.type('html').send(indexHtml));
  mounted.get('/code/sessions/:id', (_req, res) =>
    res.type('html').send(indexHtml),
  );
  mounted.get(config.OIDC_REDIRECT_PATH, (_req, res) =>
    res.type('html').send(indexHtml),
  );
  mounted.use(express.static(publicDir));

  app.use(mountPath, mounted);
  if (mountPath !== '/') {
    app.get('/health', (_req, res) =>
      res.json({ ok: true, service: 'opencortex-runtime' }),
    );
    app.get('/metrics', async (_req, res) =>
      res
        .type('text/plain; version=0.0.4')
        .send(metrics.render(codeSessions, await workflowProjections?.metrics?.())),
    );
  }

  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(400).json({ error: 'bad_request', message });
    },
  );

  return app;
}

function baseHref(mountPath: string): string {
  if (mountPath === '/') {
    return '/';
  }
  return `${mountPath.replace(/\/$/, '')}/`;
}
