import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  decodeInboxCursor,
  encodeInboxCursor,
  InvalidUserTokenError,
  issueUserToken,
  verifyUserToken,
} from '../packages/api/src/index.js';

const secret = 'a-user-token-secret-with-at-least-32-characters';
const now = () => new Date('2026-07-12T12:00:00.000Z');

describe('user tokens', () => {
  it('round trips deterministic claims and expiry', () => {
    const issued = issueUserToken('user-1', secret, { now });
    expect(issued.expiresAt).toBe('2026-07-12T12:15:00.000Z');
    expect(verifyUserToken(issued.token, secret, { now })).toEqual({
      sub: 'user-1',
      iat: 1_783_857_600,
      exp: 1_783_858_500,
    });
  });

  it('accepts immediately before expiry and rejects at expiry', () => {
    const issued = issueUserToken('user-1', secret, { now, lifetimeSeconds: 10 });
    expect(
      verifyUserToken(issued.token, secret, {
        now: () => new Date('2026-07-12T12:00:09.999Z'),
      }).sub,
    ).toBe('user-1');
    expect(() =>
      verifyUserToken(issued.token, secret, {
        now: () => new Date('2026-07-12T12:00:10.000Z'),
      }),
    ).toThrow(InvalidUserTokenError);
  });

  it.each([
    ['malformed', 'not-a-token', secret],
    ['wrong secret', issueUserToken('user-1', secret, { now }).token, `${secret}-wrong`],
    [
      'tampered signature',
      `${issueUserToken('user-1', secret, { now }).token.slice(0, -1)}x`,
      secret,
    ],
  ])('rejects %s tokens', (_label, token, verificationSecret) => {
    expect(() => verifyUserToken(token, verificationSecret, { now })).toThrow(
      InvalidUserTokenError,
    );
  });

  it('rejects malformed signed claims', () => {
    const malformedPayload = Buffer.from(JSON.stringify({ sub: '', iat: 1, exp: 2 })).toString(
      'base64url',
    );
    const signature = createHmac('sha256', secret).update(malformedPayload).digest('base64url');
    expect(() => verifyUserToken(`${malformedPayload}.${signature}`, secret, { now })).toThrow(
      InvalidUserTokenError,
    );
  });
});

describe('inbox cursors', () => {
  it('round trips createdAt and id', () => {
    const cursor = {
      createdAt: new Date('2026-07-12T12:00:00.123Z'),
      id: '10000000-0000-4000-8000-000000000001',
    };
    expect(decodeInboxCursor(encodeInboxCursor(cursor))).toEqual(cursor);
  });

  it.each(['', 'not-json', Buffer.from('{}').toString('base64url')])(
    'rejects malformed cursor %j',
    (cursor) => expect(() => decodeInboxCursor(cursor)).toThrow('Invalid inbox cursor'),
  );
});
