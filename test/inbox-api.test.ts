import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import {
  createApp,
  InboxMessageNotFoundError,
  issueUserToken,
  UserNotFoundError,
  type InboxHandlers,
} from '../packages/api/src/index.js';

const apiKey = 'api-key-with-enough-entropy-for-tests';
const tokenSecret = 'token-secret-with-enough-entropy-for-tests';
const userToken = issueUserToken('user-1', tokenSecret).token;
const message = {
  id: '10000000-0000-4000-8000-000000000001',
  notificationId: '20000000-0000-4000-8000-000000000001',
  title: 'Hello',
  body: 'World',
  readAt: null,
  createdAt: '2026-07-12T12:00:00.000Z',
};

function setup(overrides: Partial<InboxHandlers> = {}) {
  const inbox: InboxHandlers & { tokenSecret: string } = {
    tokenSecret,
    issueToken: vi.fn(async () => ({ token: userToken, expiresAt: 'future' })),
    list: vi.fn(async () => ({ items: [message], unreadCount: 1, nextCursor: null })),
    read: vi.fn(async () => message),
    readAll: vi.fn(async () => ({ updatedCount: 1, unreadCount: 0 })),
    countUnread: vi.fn(async () => 0),
    ...overrides,
  };
  return {
    inbox,
    app: createApp({
      apiKey,
      notify: vi.fn(async () => ({ notificationId: 'id', replayed: false })),
      inbox,
    }),
  };
}

describe('inbox API', () => {
  it('issues tokens through API-key authentication', async () => {
    const { app, inbox } = setup();
    const response = await request(app)
      .post('/v1/users/user-1/token')
      .set('Authorization', `Bearer ${apiKey}`);
    expect(response.status).toBe(200);
    expect(inbox.issueToken).toHaveBeenCalledWith('user-1');
  });

  it('sanitizes an unknown user', async () => {
    const { app } = setup({
      issueToken: vi.fn(async () => Promise.reject(new UserNotFoundError())),
    });
    const response = await request(app)
      .post('/v1/users/secret-user/token')
      .set('Authorization', `Bearer ${apiKey}`);
    expect(response.status).toBe(404);
    expect(response.text).not.toContain('secret-user');
  });

  it('propagates token identity and defaults list limit', async () => {
    const { app, inbox } = setup();
    const response = await request(app)
      .get('/v1/inbox')
      .set('Authorization', `Bearer ${userToken}`);
    expect(response.status).toBe(200);
    expect(inbox.list).toHaveBeenCalledWith('user-1', { limit: 20 });
  });

  it.each(['0', '101', '1.5', 'nope'])('rejects invalid limit %s', async (limit) => {
    const { app, inbox } = setup();
    const response = await request(app)
      .get(`/v1/inbox?limit=${limit}`)
      .set('Authorization', `Bearer ${userToken}`);
    expect(response.status).toBe(422);
    expect(inbox.list).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['wrong', 'Bearer wrong'],
    [
      'expired',
      `Bearer ${issueUserToken('user-1', tokenSecret, { now: () => new Date(0), lifetimeSeconds: 1 }).token}`,
    ],
  ])('rejects %s user authorization', async (_label, authorization) => {
    const { app } = setup();
    const pending = request(app).get('/v1/inbox');
    if (authorization !== undefined) pending.set('Authorization', authorization);
    expect((await pending).status).toBe(401);
  });

  it('rejects duplicate authorization headers', async () => {
    const { app } = setup();
    const response = await request(app)
      .get('/v1/inbox')
      .set('Authorization', [`Bearer ${userToken}`, `Bearer ${userToken}`]);
    expect(response.status).toBe(401);
  });

  it('routes read operations with caller identity', async () => {
    const { app, inbox } = setup();
    expect(
      (
        await request(app)
          .post(`/v1/inbox/${message.id}/read`)
          .set('Authorization', `Bearer ${userToken}`)
      ).status,
    ).toBe(200);
    expect(inbox.read).toHaveBeenCalledWith('user-1', message.id);
    expect(
      (await request(app).post('/v1/inbox/read-all').set('Authorization', `Bearer ${userToken}`))
        .body,
    ).toEqual({ updatedCount: 1, unreadCount: 0 });
    expect(inbox.readAll).toHaveBeenCalledWith('user-1');
  });

  it('uses the same 404 for missing or caller-inaccessible messages', async () => {
    const { app } = setup({
      read: vi.fn(async () => Promise.reject(new InboxMessageNotFoundError())),
    });
    const response = await request(app)
      .post(`/v1/inbox/${message.id}/read`)
      .set('Authorization', `Bearer ${userToken}`);
    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: 'not_found', message: 'Inbox message not found' },
    });
  });
});
