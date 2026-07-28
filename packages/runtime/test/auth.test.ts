import express from 'express';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import {
  assertAllowedEmailDomain,
  assertAllowedEmailDomains,
  emailToLinuxUser,
} from "../src/auth/linuxUser.js";
import {
  mintInternalToken,
  verifyInternalToken,
} from '../src/auth/internalToken.js';
import { oidcAuth, requireUser } from '../src/auth/oidc.js';
import type { AppConfig } from '../src/config/config.js';

interface IssuerCase {
  name: string;
  issuer: string;
  authEndpoint: string;
  tokenEndpoint: string;
}

describe("linux user mapping", () => {
  it("maps configured email addresses to deterministic OpenCortex Linux users", () => {
    expect(emailToLinuxUser("Matt.Fox@acme.test", { OPENCORTEX_LINUX_USER_PREFIX: "" })).toBe("matt-fox");
  });

  it("rejects domains outside the configured allowlist", () => {
    expect(() => assertAllowedEmailDomain("person@example.com", "acme.test")).toThrow(/not allowed/);
  });

  it("allows any domain when no allowlist is configured", () => {
    expect(() => assertAllowedEmailDomains("person@example.com", [])).not.toThrow();
  });

  it("accepts any configured OpenCortex email domain", () => {
    expect(() =>
      assertAllowedEmailDomains("person@contractor.example.com", [
        "example.com",
        "contractor.example.com",
      ]),
    ).not.toThrow();
  });
});

describe('OIDC auth middleware', () => {
  const issuerCases: IssuerCase[] = [
    {
      name: 'Dex',
      issuer: 'http://127.0.0.1/dex',
      authEndpoint: 'http://127.0.0.1/dex/auth',
      tokenEndpoint: 'http://127.0.0.1/dex/token',
    },
    {
      name: 'Google',
      issuer: 'https://accounts.google.com',
      authEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
    },
  ];

  for (const issuerCase of issuerCases) {
    it(`validates ${issuerCase.name} as a compliant OIDC issuer`, async () => {
      const { server, jwksUri, sign } = await startJwksServer();
      try {
        const app = authFixtureApp({
          ...issuerCase,
          jwksUri,
          requiredGroups: ['CortexUsers'],
          groupsClaim: 'groups',
          allowedDomains: ['example.com'],
        });
        const listener = app.listen(0);
        try {
          const token = await sign({
            issuer: issuerCase.issuer,
            audience: 'opencortex-runtime',
            email: 'operator@example.com',
            groups: ['CortexUsers'],
          });
          const response = await fetch(`${baseUrl(listener)}/me`, {
            headers: { authorization: `Bearer ${token}` },
          });

          expect(response.status).toBe(200);
          await expect(response.json()).resolves.toMatchObject({
            user: {
              sub: 'user-123',
              email: 'operator@example.com',
              groups: ['CortexUsers'],
              linuxUser: 'operator',
            },
          });
        } finally {
          await close(listener);
        }
      } finally {
        await close(server);
      }
    });
  }

  it('rejects tokens without the configured OIDC group claim', async () => {
    const { server, jwksUri, sign } = await startJwksServer();
    try {
      const app = authFixtureApp({
        name: 'Dex',
        issuer: 'http://127.0.0.1/dex',
        authEndpoint: 'http://127.0.0.1/dex/auth',
        tokenEndpoint: 'http://127.0.0.1/dex/token',
        jwksUri,
        requiredGroups: ['CortexUsers'],
        groupsClaim: 'groups',
        allowedDomains: ['example.com'],
      });
      const listener = app.listen(0);
      try {
        const token = await sign({
          issuer: 'http://127.0.0.1/dex',
          audience: 'opencortex-runtime',
          email: 'operator@example.com',
          groups: ['OtherGroup'],
        });
        const response = await fetch(`${baseUrl(listener)}/me`, {
          headers: { authorization: `Bearer ${token}` },
        });

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({
          error: 'missing_required_group',
        });
      } finally {
        await close(listener);
      }
    } finally {
      await close(server);
    }
  });
});

function authFixtureApp(
  options: IssuerCase & {
    jwksUri: string;
    requiredGroups: string[];
    groupsClaim: string;
    allowedDomains: string[];
  },
): express.Express {
  const app = express();
  app.use(oidcAuth(testConfig(options)));
  app.get('/me', requireUser, (req, res) => {
    res.json({ user: req.user });
  });
  return app;
}

function testConfig(
  options: IssuerCase & {
    jwksUri: string;
    requiredGroups: string[];
    groupsClaim: string;
    allowedDomains: string[];
  },
): AppConfig {
  return {
    NODE_ENV: 'test',
    PORT: 0,
    OPENCORTEX_PUBLIC_BASE_URL: 'http://127.0.0.1',
    OPENCORTEX_BASE_PATH: '',
    OPENCORTEX_DATA_DIR: '/tmp/opencortex-auth-test',
    OIDC_ISSUER: options.issuer,
    OIDC_CLIENT_ID: 'opencortex-runtime',
    OIDC_CLIENT_SECRET: '',
    OIDC_REDIRECT_PATH: '/auth/callback',
    OIDC_REQUIRED_GROUPS: options.requiredGroups,
    OIDC_GROUPS_CLAIM: options.groupsClaim,
    OIDC_SCOPES: ['openid', 'email', 'profile'],
    OIDC_AUTHORIZATION_ENDPOINT: options.authEndpoint,
    OIDC_TOKEN_ENDPOINT: options.tokenEndpoint,
    OIDC_JWKS_URI: options.jwksUri,
    OIDC_END_SESSION_ENDPOINT: '',
    DIWAN_ALLOWED_EMAIL_DOMAIN: '',
    OPENCORTEX_ALLOWED_EMAIL_DOMAINS: options.allowedDomains,
    OPENCORTEX_SUPER_ADMIN_EMAILS: [],
    OPENCORTEX_INTERNAL_TOKEN_SECRET: 'test-internal-token-secret-32-bytes',
    OPENCORTEX_MEMORY_DATABASE_URL: '',
    OPENCORTEX_LINUX_USER_PREFIX: '',
    OPENCORTEX_WORKSPACE_ROOT: '/srv/opencortex/workspaces',
    OPENCORTEX_EXEC_MODE: 'dry-run',
    OPENCORTEX_WORKBENCH_PORT_BASE: 4100,
    OPENCORTEX_WORKBENCH_BIN: '/usr/local/bin/opencode',
    OPENCORTEX_PROVISION_USER_SCRIPT: '/opt/opencortex/scripts/provision-opencortex-user.sh',
    OPENCORTEX_JIRA_BASE_URL: '',
    SLACK_BOT_TOKEN: '',
    SLACK_API_BASE_URL: 'https://slack.com/api',
    SLACK_WORKSPACE_URL: '',
    SLACK_SESSION_CHANNEL_PREFIX: 'opencortex',
  };
}

describe('internal scoped tokens', () => {
  it('mints and verifies short-lived scoped tokens for an OIDC user', async () => {
    const minted = await mintInternalToken({
      user: {
        sub: 'oidc:issuer:user-123',
        email: 'operator@example.com',
        groups: ['CortexUsers'],
        linuxUser: 'operator',
      },
      scopes: ['memory:read', 'memory:write'],
      secret: 'test-internal-token-secret-32-bytes',
      ttlSeconds: 60,
    });

    const verified = await verifyInternalToken(
      minted.token,
      'test-internal-token-secret-32-bytes',
      ['memory:write'],
    );

    expect(verified).toMatchObject({
      subject: 'oidc:issuer:user-123',
      ownerEmail: 'operator@example.com',
      linuxUser: 'operator',
      scopes: ['memory:read', 'memory:write'],
    });
  });
});

async function startJwksServer(): Promise<{
  server: Server;
  jwksUri: string;
  sign: (claims: {
    issuer: string;
    audience: string;
    email: string;
    groups: string[];
  }) => Promise<string>;
}> {
  const keyPair = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(keyPair.publicKey);
  const jwks = {
    keys: [{ ...publicJwk, kid: 'test-key', alg: 'RS256', use: 'sig' }],
  };
  const server = createServer((req, res) => {
    if (req.url === '/jwks') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(jwks));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await listen(server);
  return {
    server,
    jwksUri: `${baseUrl(server)}/jwks`,
    sign: claims =>
      new SignJWT({
        sub: 'user-123',
        email: claims.email,
        groups: claims.groups,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(claims.issuer)
        .setAudience(claims.audience)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(keyPair.privateKey),
  };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
}

function close(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

function baseUrl(server: Server): string {
  const address = server.address() as AddressInfo | null;
  if (!address) {
    throw new Error('server is not listening');
  }
  return `http://127.0.0.1:${address.port}`;
}
