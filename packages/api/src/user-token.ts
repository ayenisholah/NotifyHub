import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

export const USER_TOKEN_LIFETIME_SECONDS = 15 * 60;

export interface UserTokenClaims {
  sub: string;
  iat: number;
  exp: number;
}

export interface IssueUserTokenOptions {
  lifetimeSeconds?: number;
  now?: () => Date;
}

export interface VerifyUserTokenOptions {
  now?: () => Date;
}

export interface IssuedUserToken {
  token: string;
  expiresAt: string;
}

export class InvalidUserTokenError extends Error {
  public constructor() {
    super('Invalid or expired user token');
    this.name = 'InvalidUserTokenError';
  }
}

const claimsSchema = z
  .object({
    sub: z.string().min(1).max(128),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
  })
  .strict()
  .refine((claims) => claims.exp > claims.iat);

function sign(payload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(payload).digest();
}

export function issueUserToken(
  subject: string,
  secret: string,
  options: IssueUserTokenOptions = {},
): IssuedUserToken {
  const parsedSubject = z.string().min(1).max(128).parse(subject);
  const lifetime = options.lifetimeSeconds ?? USER_TOKEN_LIFETIME_SECONDS;
  if (!Number.isInteger(lifetime) || lifetime <= 0) throw new RangeError('Invalid token lifetime');
  const issuedAt = Math.floor((options.now?.() ?? new Date()).getTime() / 1000);
  const claims: UserTokenClaims = { sub: parsedSubject, iat: issuedAt, exp: issuedAt + lifetime };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = sign(payload, secret).toString('base64url');
  return {
    token: `${payload}.${signature}`,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
  };
}

export function verifyUserToken(
  token: string,
  secret: string,
  options: VerifyUserTokenOptions = {},
): UserTokenClaims {
  try {
    const parts = token.split('.');
    if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
      throw new InvalidUserTokenError();
    }
    const expected = sign(parts[0], secret);
    const submitted = Buffer.from(parts[1], 'base64url');
    if (
      submitted.toString('base64url') !== parts[1] ||
      submitted.length !== expected.length ||
      !timingSafeEqual(submitted, expected)
    ) {
      throw new InvalidUserTokenError();
    }
    const claims = claimsSchema.parse(
      JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')),
    );
    const now = Math.floor((options.now?.() ?? new Date()).getTime() / 1000);
    if (claims.exp <= now || claims.iat > now) throw new InvalidUserTokenError();
    return claims;
  } catch (error) {
    if (error instanceof InvalidUserTokenError) throw error;
    throw new InvalidUserTokenError();
  }
}
