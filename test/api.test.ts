import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import {
  createApp,
  createPersistentNotifyHandler,
  type NotifyHandler,
  type NotifyRequest,
  type NotifyResult,
} from '../packages/api/src/index.js';
import type { PrismaClient } from '../packages/core/src/index.js';

const apiKey = 'correct-api-key-with-enough-entropy';
const authorization = `Bearer ${apiKey}`;
const validBody = {
  userId: 'user-123',
  event: 'invoice.paid',
  payload: { invoiceId: 'invoice-456', amount: 42 },
  idempotencyKey: 'request-789',
};

function appWith(
  handler: NotifyHandler = vi.fn(async () => ({
    notificationId: 'notification-1',
    replayed: false,
  })),
) {
  return { app: createApp({ apiKey, notify: handler }), handler };
}

describe('POST /v1/notify authentication', () => {
  it('passes a valid normalized request to the handler and returns 202', async () => {
    const { app, handler } = appWith();

    const response = await request(app)
      .post('/v1/notify')
      .set('Authorization', authorization)
      .send(validBody);

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ notificationId: 'notification-1' });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(validBody satisfies NotifyRequest);

    const result: NotifyResult = {
      notificationId: response.body.notificationId as string,
      replayed: false,
    };
    expect(result.notificationId).toBe('notification-1');
  });

  it('returns 200 with the original ID for an idempotency replay', async () => {
    const { app } = appWith(
      vi.fn(async () => ({ notificationId: 'notification-original', replayed: true })),
    );

    const response = await request(app)
      .post('/v1/notify')
      .set('Authorization', authorization)
      .send(validBody);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ notificationId: 'notification-original' });
  });

  it.each([
    ['missing', undefined],
    ['malformed', apiKey],
    ['wrong', 'Bearer wrong-api-key-with-enough-entropy'],
    ['differently cased scheme', `bearer ${apiKey}`],
    ['differently cased token', `Bearer ${apiKey.toUpperCase()}`],
  ])('returns the same 401 for %s credentials', async (_label, header) => {
    const { app, handler } = appWith();
    const pending = request(app).post('/v1/notify').send('{not json');
    if (header !== undefined) pending.set('Authorization', header);

    const response = await pending;

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: { code: 'unauthorized', message: 'Valid bearer token required' },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects duplicate authorization headers without parsing the body', async () => {
    const { app, handler } = appWith();
    const response = await request(app)
      .post('/v1/notify')
      .set('Authorization', [authorization, authorization])
      .send('{not json');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: { code: 'unauthorized', message: 'Valid bearer token required' },
    });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('POST /v1/notify validation', () => {
  it.each([
    ['missing userId', { event: 'event', payload: {} }, 'userId'],
    ['empty userId', { ...validBody, userId: '' }, 'userId'],
    ['oversized userId', { ...validBody, userId: 'u'.repeat(129) }, 'userId'],
    ['missing event', { userId: 'user', payload: {} }, 'event'],
    ['empty event', { ...validBody, event: '' }, 'event'],
    ['oversized event', { ...validBody, event: 'e'.repeat(129) }, 'event'],
    ['missing payload', { userId: 'user', event: 'event' }, 'payload'],
    ['array payload', { ...validBody, payload: [] }, 'payload'],
    ['primitive payload', { ...validBody, payload: 'secret-value' }, 'payload'],
    ['unknown field', { ...validBody, extra: true }, ''],
    ['empty idempotency key', { ...validBody, idempotencyKey: '' }, 'idempotencyKey'],
    [
      'oversized idempotency key',
      { ...validBody, idempotencyKey: 'i'.repeat(256) },
      'idempotencyKey',
    ],
  ])('returns variable-specific 422 errors for %s', async (_label, body, expectedPath) => {
    const { app, handler } = appWith();
    const response = await request(app)
      .post('/v1/notify')
      .set('Authorization', authorization)
      .send(body);

    expect(response.status).toBe(422);
    expect(response.body.error).toMatchObject({
      code: 'validation_error',
      message: 'Request validation failed',
    });
    expect(response.body.error.fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: expectedPath })]),
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 400 for malformed JSON', async () => {
    const { app, handler } = appWith();
    const response = await request(app)
      .post('/v1/notify')
      .set('Authorization', authorization)
      .set('Content-Type', 'application/json')
      .send('{"userId":');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: { code: 'invalid_json', message: 'Request body must be valid JSON' },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 413 for JSON bodies above 100 KiB', async () => {
    const { app, handler } = appWith();
    const response = await request(app)
      .post('/v1/notify')
      .set('Authorization', authorization)
      .send({ ...validBody, payload: { value: 'x'.repeat(101 * 1024) } });

    expect(response.status).toBe(413);
    expect(response.body).toEqual({
      error: { code: 'payload_too_large', message: 'Request body exceeds 100 KiB' },
    });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('POST /v1/notify failures', () => {
  it('returns a sanitized 500 response when the handler fails', async () => {
    const secretException = `failure: ${apiKey} secret-request-value`;
    const { app } = appWith(vi.fn(async () => Promise.reject(new Error(secretException))));

    const response = await request(app)
      .post('/v1/notify')
      .set('Authorization', authorization)
      .send({ ...validBody, payload: { private: 'secret-request-value' } });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: 'internal_error', message: 'Internal server error' },
    });
    expect(response.text).not.toContain(apiKey);
    expect(response.text).not.toContain('secret-request-value');
    expect(response.text).not.toContain(secretException);
    expect(response.text).not.toContain('stack');
  });

  it('sanitizes database failures from the persistent handler', async () => {
    const databaseMessage = 'database unavailable at private-host';
    const prisma = {
      notification: { create: vi.fn(async () => Promise.reject(new Error(databaseMessage))) },
    } as unknown as PrismaClient;
    const enqueue = vi.fn(async () => undefined);
    const app = createApp({
      apiKey,
      notify: createPersistentNotifyHandler(prisma, { enqueue }),
    });

    const response = await request(app)
      .post('/v1/notify')
      .set('Authorization', authorization)
      .send(validBody);

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: 'internal_error', message: 'Internal server error' },
    });
    expect(response.text).not.toContain(databaseMessage);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
