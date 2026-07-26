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
  publicRouter,
  rawOpenCodeSessionRedirect,
} from './routes.js';
import { SessionStore } from '../code/sessionStore.js';
import { ChatStore } from '../chat/chatStore.js';
import { PairPromptStore } from '../pairPrompts/pairPromptStore.js';
import { JiraTrackingStore } from '../jira/jiraTrackingStore.js';

export function createApp(
  config: AppConfig,
  codeSessions: SessionStore = new SessionStore(config.DIWAN_DATA_DIR),
  chat: ChatStore = new ChatStore(config),
  pairPrompts: PairPromptStore = new PairPromptStore(config.DIWAN_DATA_DIR),
  jiraTracking: JiraTrackingStore = new JiraTrackingStore(
    config.DIWAN_DATA_DIR,
  ),
): express.Express {
  const app = express();
  const mountPath = config.DIWAN_BASE_PATH || '/';
  const publicDir = new URL('../ui/public', import.meta.url).pathname;
  const indexPath = new URL('../ui/public/index.html', import.meta.url)
    .pathname;
  const indexHtml = readFileSync(indexPath, 'utf8').replace(
    '%DIWAN_BASE_HREF%',
    baseHref(mountPath),
  );

  app.use(helmet());
  // Parse JSON bodies for Diwan's own API, but NOT for the OpenCode session
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
    res.json({ ok: true, service: 'diwan-runtime' }),
  );
  mounted.use('/api', publicRouter(config));
  mounted.use(
    '/api',
    oidcAuth(config),
    apiRouter(config, codeSessions, chat, pairPrompts, jiraTracking),
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
      res.json({ ok: true, service: 'diwan-runtime' }),
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
