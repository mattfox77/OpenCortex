import type { RequestHandler } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';
import type { AppConfig } from '../config/config.js';
import { cognitoIssuer } from '../config/config.js';
import { assertAllowedEmailDomain, emailToLinuxUser } from './linuxUser.js';

const authCookieName = 'diwan.idToken';

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

function groupsFrom(payload: JWTPayload): string[] {
  const value = payload['cognito:groups'];
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

export function cognitoAuth(config: AppConfig): RequestHandler {
  const issuer = cognitoIssuer(config);
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));

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
          assertAllowedEmailDomain(email, config.DIWAN_ALLOWED_EMAIL_DOMAIN);
          req.user = {
            sub: `dev:${email}`,
            email,
            groups: config.COGNITO_REQUIRED_GROUPS,
            linuxUser: emailToLinuxUser(email, config),
            isSuperAdmin: isSuperAdminEmail(email, config),
          };
          return next();
        }
      }

      if (!token) {
        return res.status(401).json({ error: 'missing_bearer_token' });
      }

      const result = await jwtVerify(token, jwks, {
        issuer,
        audience: config.COGNITO_APP_CLIENT_ID,
      });

      const email = String(result.payload.email ?? '').toLowerCase();
      if (!email) {
        return res.status(403).json({ error: 'missing_email_claim' });
      }

      assertAllowedEmailDomain(email, config.DIWAN_ALLOWED_EMAIL_DOMAIN);

      const groups = groupsFrom(result.payload);
      if (!hasAnyRequiredGroup(groups, config.COGNITO_REQUIRED_GROUPS)) {
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
