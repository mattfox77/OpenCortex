import type { RequestHandler } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';
import type { AppConfig } from '../config/config.js';
import { assertAllowedEmailDomains, emailToLinuxUser } from './linuxUser.js';

const authCookieName = 'diwan.idToken';

interface OidcProviderMetadata {
  issuer: string;
  jwks_uri: string;
  authorization_endpoint: string;
  token_endpoint: string;
  end_session_endpoint?: string;
}

function bearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] ?? null;
}

function tokenFromRequest(req: Parameters<RequestHandler>[0]): string | null {
  const headerToken = bearerToken(req.header('authorization'));
  if (headerToken) {
    return headerToken;
  }
  const cookies = req.cookies as Record<string, string | undefined> | undefined;
  return cookies?.[authCookieName] ?? null;
}

function groupsFrom(payload: JWTPayload, groupsClaim: string): string[] {
  const value = payload[groupsClaim] ?? payload['cognito:groups'];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (typeof value === 'string') {
    return [value];
  }
  return [];
}

function hasAnyRequiredGroup(
  userGroups: string[],
  requiredGroups: string[],
): boolean {
  if (requiredGroups.length === 0) {
    return true;
  }
  return requiredGroups.some(group => userGroups.includes(group));
}

export function oidcAuth(config: AppConfig): RequestHandler {
  let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  return async (req, res, next) => {
    try {
      const token = tokenFromRequest(req);

      if (config.NODE_ENV === 'development') {
        const devCredential =
          req.header('authorization') ??
          (req.cookies as Record<string, string | undefined> | undefined)?.[
            authCookieName
          ] ??
          '';
        const devMatch = /^Dev\s+(.+@.+)$/i.exec(devCredential);
        if (devMatch) {
          const email = devMatch[1].toLowerCase();
          assertAllowedEmailDomains(email, config.DIWAN_ALLOWED_EMAIL_DOMAINS);
          req.user = {
            sub: `dev:${email}`,
            email,
            groups: config.OIDC_REQUIRED_GROUPS,
            linuxUser: emailToLinuxUser(email, config),
            isSuperAdmin: isSuperAdminEmail(email, config),
          };
          return next();
        }
      }

      if (!token) {
        return res.status(401).json({ error: 'missing_bearer_token' });
      }

      const metadata = await oidcProviderMetadata(config);
      jwks ??= createRemoteJWKSet(new URL(metadata.jwks_uri));
      const result = await jwtVerify(token, jwks, {
        issuer: metadata.issuer,
        audience: config.OIDC_CLIENT_ID,
      });

      const email = String(result.payload.email ?? '').toLowerCase();
      if (!email) {
        return res.status(403).json({ error: 'missing_email_claim' });
      }

      assertAllowedEmailDomains(email, config.DIWAN_ALLOWED_EMAIL_DOMAINS);

      const groups = groupsFrom(result.payload, config.OIDC_GROUPS_CLAIM);
      if (!hasAnyRequiredGroup(groups, config.OIDC_REQUIRED_GROUPS)) {
        return res.status(403).json({ error: 'missing_required_group' });
      }

      req.user = {
        sub: String(result.payload.sub),
        email,
        name:
          typeof result.payload.name === 'string'
            ? result.payload.name
            : undefined,
        groups,
        linuxUser: emailToLinuxUser(email, config),
        isSuperAdmin: isSuperAdminEmail(email, config),
      };
      return next();
    } catch (error) {
      return res.status(401).json({
        error: 'invalid_token',
        message: error instanceof Error ? error.message : 'Unknown auth error',
      });
    }
  };
}

const metadataPromises = new Map<string, Promise<OidcProviderMetadata>>();

export async function oidcProviderMetadata(
  config: AppConfig,
): Promise<OidcProviderMetadata> {
  const configured = configuredOidcMetadata(config);
  if (configured) {
    return configured;
  }

  const discoveryUrl = `${config.OIDC_ISSUER}/.well-known/openid-configuration`;
  const cached = metadataPromises.get(discoveryUrl);
  if (cached) {
    return cached;
  }

  const promise = fetch(discoveryUrl).then(async response => {
    if (!response.ok) {
      throw new Error(`OIDC metadata discovery failed: ${response.status}`);
    }
    const metadata = await response.json() as Partial<OidcProviderMetadata>;
    if (
      metadata.issuer !== config.OIDC_ISSUER ||
      !metadata.jwks_uri ||
      !metadata.authorization_endpoint ||
      !metadata.token_endpoint
    ) {
      throw new Error('OIDC metadata discovery returned incomplete metadata');
    }
    return metadata as OidcProviderMetadata;
  });
  metadataPromises.set(discoveryUrl, promise);
  return promise;
}

function configuredOidcMetadata(config: AppConfig): OidcProviderMetadata | null {
  if (
    !config.OIDC_JWKS_URI ||
    !config.OIDC_AUTHORIZATION_ENDPOINT ||
    !config.OIDC_TOKEN_ENDPOINT
  ) {
    return null;
  }

  return {
    issuer: config.OIDC_ISSUER,
    jwks_uri: config.OIDC_JWKS_URI,
    authorization_endpoint: config.OIDC_AUTHORIZATION_ENDPOINT,
    token_endpoint: config.OIDC_TOKEN_ENDPOINT,
    ...(config.OIDC_END_SESSION_ENDPOINT
      ? { end_session_endpoint: config.OIDC_END_SESSION_ENDPOINT }
      : {}),
  };
}

export const requireUser: RequestHandler = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'unauthenticated' });
  }
  return next();
};

function isSuperAdminEmail(
  email: string,
  config: Pick<AppConfig, 'DIWAN_SUPER_ADMIN_EMAILS'>,
): boolean {
  return config.DIWAN_SUPER_ADMIN_EMAILS.some(
    superAdminEmail => superAdminEmail.toLowerCase() === email.toLowerCase(),
  );
}
