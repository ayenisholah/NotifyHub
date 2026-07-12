import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import {
  createApp,
  decodeDlqCursor,
  DlqNotFoundError,
  DlqRetryConflictError,
  encodeDlqCursor,
} from '../packages/api/src/index.js';

const apiKey = 'api-key-with-at-least-32-characters';
const operatorKey = 'operator-key-with-at-least-32-chars';
const deliveryId = '3fdb2e8c-3bf1-45bf-af46-ac120852116f';

function appWith(
  options: {
    list?: ReturnType<typeof vi.fn>;
    retry?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const list = options.list ?? vi.fn(async () => ({ items: [], nextCursor: null }));
  const retry = options.retry ?? vi.fn(async () => ({ replayed: false }));
  return {
    app: createApp({
      apiKey,
      notify: async () => ({ notificationId: 'notification-id', replayed: false }),
      dlq: { operatorKey, list, retry },
    }),
    list,
    retry,
  };
}

describe('DLQ cursors', () => {
  it('round-trips opaque cursor values and rejects malformed input', () => {
    const value = { updatedAt: new Date('2026-07-12T12:00:00.000Z'), id: deliveryId };
    expect(decodeDlqCursor(encodeDlqCursor(value))).toEqual(value);
    expect(() => decodeDlqCursor('not-a-cursor')).toThrow('Invalid DLQ cursor');
  });
});

describe('operator DLQ API', () => {
  it('requires the operator key independently of the ingestion API key', async () => {
    const { app, list } = appWith();
    for (const authorization of [undefined, `Bearer ${apiKey}`, 'Bearer wrong']) {
      const pending = request(app).get('/v1/dlq');
      if (authorization !== undefined) pending.set('Authorization', authorization);
      expect((await pending).status).toBe(401);
    }
    expect(list).not.toHaveBeenCalled();
  });

  it('validates list input and returns the handler envelope', async () => {
    const list = vi.fn(async () => ({ items: [{ deliveryId }], nextCursor: 'next' }));
    const { app } = appWith({ list });
    const response = await request(app)
      .get('/v1/dlq?limit=25&cursor=opaque')
      .set('Authorization', `Bearer ${operatorKey}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: [{ deliveryId }], nextCursor: 'next' });
    expect(list).toHaveBeenCalledWith({ limit: 25, cursor: 'opaque' });
    for (const query of ['limit=0', 'limit=101', 'limit=invalid', 'cursor=']) {
      expect(
        (await request(app).get(`/v1/dlq?${query}`).set('Authorization', `Bearer ${operatorKey}`))
          .status,
      ).toBe(422);
    }
  });

  it('returns 202 for a new retry and 200 for an idempotent replay', async () => {
    for (const [replayed, status] of [
      [false, 202],
      [true, 200],
    ] as const) {
      const retry = vi.fn(async () => ({ replayed }));
      const { app } = appWith({ retry });
      const response = await request(app)
        .post(`/v1/dlq/${deliveryId}/retry`)
        .set('Authorization', `Bearer ${operatorKey}`);
      expect(response.status).toBe(status);
      expect(response.body).toEqual({ deliveryId });
    }
  });

  it('maps invalid, missing, and conflicting retries without leaking details', async () => {
    expect(
      (
        await request(appWith().app)
          .post('/v1/dlq/not-a-uuid/retry')
          .set('Authorization', `Bearer ${operatorKey}`)
      ).status,
    ).toBe(422);
    for (const [error, status] of [
      [new DlqNotFoundError(deliveryId), 404],
      [new DlqRetryConflictError(deliveryId), 409],
    ] as const) {
      const { app } = appWith({ retry: vi.fn(async () => Promise.reject(error)) });
      const response = await request(app)
        .post(`/v1/dlq/${deliveryId}/retry`)
        .set('Authorization', `Bearer ${operatorKey}`);
      expect(response.status).toBe(status);
      expect(response.text).not.toContain(deliveryId);
    }
  });
});
