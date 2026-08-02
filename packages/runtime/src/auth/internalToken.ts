import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';
import type { AuthenticatedUser } from './types.js';

export const internalTokenIssuer = 'opencortex-runtime';
export const internalTokenAudience = 'opencortex-internal';
export const internalTokenScopes = [
  'memory:read',
  'memory:write',
  'session',
  'pair-prompt',
] as const;

export type InternalTokenScope = typeof internalTokenScopes[number];

export interface InternalTokenClaims {
  subject: string;
  ownerEmail: string;
  linuxUser: string;
  scopes: InternalTokenScope[];
}

export interface VerifiedInternalToken extends InternalTokenClaims {
  tokenId?: string;
  expiresAt?: number;
}

export async function mintInternalToken(params: {
  user: AuthenticatedUser;
  scopes: InternalTokenScope[];
  secret: string;
  ttlSeconds?: number;
}): Promise<{ token: string; expiresAt: Date }> {
  const ttlSeconds = params.ttlSeconds ?? 900;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const token = await new SignJWT({
    owner_email: params.user.email,
    linux_user: params.user.linuxUser,
    scopes: params.scopes,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(internalTokenIssuer)
    .setAudience(internalTokenAudience)
    .setSubject(params.user.sub)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(secretKey(params.secret));
  return { token, expiresAt };
}

export async function verifyInternalToken(
  token: string,
  secret: string,
  requiredScopes: InternalTokenScope[] = [],
): Promise<VerifiedInternalToken> {
  const result = await jwtVerify(token, secretKey(secret), {
    issuer: internalTokenIssuer,
    audience: internalTokenAudience,
  });
  const scopes = scopesFromPayload(result.payload);
  for (const required of requiredScopes) {
    if (!scopes.includes(required)) {
      throw new Error(`internal token is missing required scope: ${required}`);
    }
  }
  return {
    subject: String(result.payload.sub ?? ''),
    ownerEmail: stringClaim(result.payload, 'owner_email'),
    linuxUser: stringClaim(result.payload, 'linux_user'),
    scopes,
    tokenId: result.payload.jti,
    expiresAt: result.payload.exp,
  };
}

export function parseInternalTokenScopes(value: unknown): InternalTokenScope[] {
  if (!Array.isArray(value)) {
    throw new TypeError('scopes must be an array');
  }
  const scopes = value.filter(
    (scope): scope is InternalTokenScope =>
      typeof scope === 'string' &&
      (internalTokenScopes as readonly string[]).includes(scope),
  );
  if (scopes.length !== value.length || scopes.length === 0) {
    throw new TypeError(`scopes must contain one or more of: ${internalTokenScopes.join(', ')}`);
  }
  return [...new Set(scopes)];
}

function scopesFromPayload(payload: JWTPayload): InternalTokenScope[] {
  return parseInternalTokenScopes(payload.scopes);
}

function stringClaim(payload: JWTPayload, claim: string): string {
  const value = payload[claim];
  if (typeof value !== 'string' || !value) {
    throw new Error(`internal token missing ${claim}`);
  }
  return value;
}

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}
