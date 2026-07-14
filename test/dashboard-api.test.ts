import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createApp,
  createPersistentDashboardHandlers,
  DashboardNotificationNotFoundError,
  decodeDashboardDlqCursor,
  decodeDashboardNotificationCursor,
  encodeDashboardDlqCursor,
  encodeDashboardNotificationCursor,
  InvalidDashboardDlqCursorError,
  InvalidDashboardNotificationCursorError,
  type DashboardHandlers,
} from '../packages/api/src/index.js';
import {
  Channel,
  DeliveryStatus,
  NotificationStatus,
  type PrismaClient,
} from '../packages/core/src/index.js';

const apiKey = 'dashboard-api-key-with-enough-entropy';
const notificationId = '10000000-0000-4000-8000-000000000001';
const deliveryId = '20000000-0000-4000-8000-000000000001';
const createdAt = '2026-07-13T10:00:00.000Z';

const notification = {
  notificationId,
  event: 'invoice.paid',
  status: NotificationStatus.ROUTED,
  reason: null,
  createdAt,
  deliveries: [
    {
      deliveryId,
      channel: Channel.EMAIL,
      status: DeliveryStatus.SENT,
      attempts: 1,
      createdAt,
      updatedAt: '2026-07-13T10:00:01.000Z',
    },
  ],
};

function setup(overrides: Partial<DashboardHandlers> = {}) {
  const dashboard: DashboardHandlers = {
    summary: vi.fn(async () => ({ sentToday: 1, inFlight: 2, failed: 3, dlq: 4 })),
    listNotifications: vi.fn(async () => ({ items: [notification], nextCursor: null })),
    getNotification: vi.fn(async () => ({
      ...notification,
      deliveries: [
        {
          ...notification.deliveries[0]!,
          timeline: [
            {
              status: DeliveryStatus.SENT,
              createdAt: '2026-07-13T10:00:01.000Z',
              reason: 'email_sent',
              errorClassification: null,
            },
          ],
        },
      ],
    })),
    listDlq: vi.fn(async () => ({ items: [], nextCursor: null })),
    ...overrides,
  };
  return {
    dashboard,
    app: createApp({
      apiKey,
      notify: vi.fn(async () => ({ notificationId, replayed: false })),
      dashboard,
    }),
  };
}

describe('dashboard cursors', () => {
  it('round-trips canonical timestamp-and-ID cursors', () => {
    const notificationCursor = {
      createdAt: new Date('2026-07-13T10:00:00.000Z'),
      id: notificationId,
    };
    const dlqCursor = {
      updatedAt: new Date('2026-07-13T11:00:00.000Z'),
      id: deliveryId,
    };
    expect(
      decodeDashboardNotificationCursor(encodeDashboardNotificationCursor(notificationCursor)),
    ).toEqual(notificationCursor);
    expect(decodeDashboardDlqCursor(encodeDashboardDlqCursor(dlqCursor))).toEqual(dlqCursor);
  });

  it('rejects malformed, non-canonical, and augmented cursor values', () => {
    const augmented = Buffer.from(
      JSON.stringify({ createdAt, id: notificationId, secret: 'must-not-be-accepted' }),
    ).toString('base64url');
    expect(() => decodeDashboardNotificationCursor('not a cursor')).toThrow(
      InvalidDashboardNotificationCursorError,
    );
    expect(() => decodeDashboardNotificationCursor(augmented)).toThrow(
      InvalidDashboardNotificationCursorError,
    );
    expect(() => decodeDashboardDlqCursor('bm90LWpzb24=')).toThrow(InvalidDashboardDlqCursorError);
  });
});

describe('persistent dashboard query boundaries', () => {
  it('captures one clock value and scopes every counter to the trimmed demo user', async () => {
    const findMany = vi.fn(async () => [{ deliveryId }]);
    const counts = [4, 1, 1];
    const count = vi.fn(async () => counts.shift()!);
    const transaction = vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations));
    const prisma = {
      deliveryEvent: { findMany },
      delivery: { count },
      $transaction: transaction,
    } as unknown as PrismaClient;
    const clock = vi.fn(() => new Date('2026-07-13T12:34:56.789Z'));

    const result = await createPersistentDashboardHandlers(prisma, '  synthetic-demo  ', {
      now: clock,
    }).summary();

    expect(result).toEqual({ sentToday: 1, inFlight: 4, failed: 1, dlq: 1 });
    expect(clock).toHaveBeenCalledOnce();
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: DeliveryStatus.SENT,
          createdAt: {
            gte: new Date('2026-07-13T00:00:00.000Z'),
            lte: new Date('2026-07-13T12:34:56.789Z'),
          },
          delivery: { notification: { userId: 'synthetic-demo' } },
        },
        distinct: ['deliveryId'],
        select: { deliveryId: true },
      }),
    );
    expect(count.mock.calls.map(([input]) => input)).toEqual([
      {
        where: {
          notification: { userId: 'synthetic-demo' },
          status: {
            in: [
              DeliveryStatus.QUEUED,
              DeliveryStatus.SCHEDULED,
              DeliveryStatus.PROCESSING,
              DeliveryStatus.RETRYING,
            ],
          },
        },
      },
      {
        where: {
          notification: { userId: 'synthetic-demo' },
          status: DeliveryStatus.FAILED,
        },
      },
      {
        where: {
          notification: { userId: 'synthetic-demo' },
          status: DeliveryStatus.DLQ,
        },
      },
    ]);
  });

  it('puts an explicit demo-user predicate and narrow selects on every persistent read', async () => {
    const notificationFindMany = vi.fn(async () => []);
    const notificationFindFirst = vi.fn(async () => null);
    const deliveryFindMany = vi.fn(async () => []);
    const prisma = {
      notification: { findMany: notificationFindMany, findFirst: notificationFindFirst },
      delivery: { findMany: deliveryFindMany },
    } as unknown as PrismaClient;
    const handlers = createPersistentDashboardHandlers(prisma, 'synthetic-demo');

    await handlers.listNotifications({ limit: 7 });
    await expect(handlers.getNotification(notificationId)).rejects.toBeInstanceOf(
      DashboardNotificationNotFoundError,
    );
    await handlers.listDlq({ limit: 9 });

    expect(notificationFindMany.mock.calls[0]![0]).toMatchObject({
      where: { userId: 'synthetic-demo' },
      take: 8,
    });
    expect(notificationFindFirst.mock.calls[0]![0]).toMatchObject({
      where: { id: notificationId, userId: 'synthetic-demo' },
    });
    expect(deliveryFindMany.mock.calls[0]![0]).toMatchObject({
      where: {
        status: DeliveryStatus.DLQ,
        notification: { userId: 'synthetic-demo' },
      },
      take: 10,
    });
    const queryArguments = JSON.stringify([
      notificationFindMany.mock.calls[0]![0],
      notificationFindFirst.mock.calls[0]![0],
      deliveryFindMany.mock.calls[0]![0],
    ]);
    for (const selection of [
      'payload',
      'user',
      'email',
      'phone',
      'providerMessageId',
      'lastError',
    ]) {
      expect(queryArguments).not.toContain(`"${selection}":true`);
    }
  });

  it('rejects an empty normalized demo-user scope', () => {
    expect(() => createPersistentDashboardHandlers({} as PrismaClient, '   ')).toThrow(
      'demoUserId must contain 1-128 characters',
    );
  });
});

describe('public dashboard API', () => {
  it('serves all read routes without credentials and passes query defaults', async () => {
    const { app, dashboard } = setup();

    const summaryResponse = await request(app).get('/v1/dashboard/summary');
    expect(summaryResponse).toMatchObject({
      status: 200,
      body: { sentToday: 1, inFlight: 2, failed: 3, dlq: 4 },
    });
    expect(summaryResponse.headers['cache-control']).toBe('no-store');
    await expect(request(app).get('/v1/dashboard/notifications')).resolves.toMatchObject({
      status: 200,
      body: { items: [notification], nextCursor: null },
    });
    await expect(
      request(app).get(`/v1/dashboard/notifications/${notificationId}`),
    ).resolves.toMatchObject({ status: 200 });
    await expect(request(app).get('/v1/dashboard/dlq')).resolves.toMatchObject({
      status: 200,
      body: { items: [], nextCursor: null },
    });

    expect(dashboard.listNotifications).toHaveBeenCalledWith({ limit: 20 });
    expect(dashboard.getNotification).toHaveBeenCalledWith(notificationId);
    expect(dashboard.listDlq).toHaveBeenCalledWith({ limit: 20 });
  });

  it('passes explicit pagination inputs to list handlers', async () => {
    const { app, dashboard } = setup();
    expect(
      (await request(app).get('/v1/dashboard/notifications?limit=37&cursor=opaque')).status,
    ).toBe(200);
    expect((await request(app).get('/v1/dashboard/dlq?limit=9&cursor=dlq-cursor')).status).toBe(
      200,
    );
    expect(dashboard.listNotifications).toHaveBeenCalledWith({ limit: 37, cursor: 'opaque' });
    expect(dashboard.listDlq).toHaveBeenCalledWith({ limit: 9, cursor: 'dlq-cursor' });
  });

  it.each([
    '/v1/dashboard/notifications?limit=0',
    '/v1/dashboard/notifications?limit=101',
    '/v1/dashboard/notifications?limit=1.5',
    '/v1/dashboard/notifications?limit=nope',
    '/v1/dashboard/notifications?cursor=',
    '/v1/dashboard/notifications?unknown=value',
    '/v1/dashboard/dlq?limit=0',
    '/v1/dashboard/dlq?limit=101',
    '/v1/dashboard/dlq?cursor=',
    '/v1/dashboard/dlq?unknown=value',
  ])('returns a sanitized 422 for invalid query %s', async (url) => {
    const { app } = setup();
    const response = await request(app).get(url);
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ error: { code: 'validation_error' } });
    expect(response.text).not.toContain('Zod');
  });

  it('maps opaque cursor failures to route-specific sanitized 422 responses', async () => {
    const notificationResponse = await request(
      setup({
        listNotifications: vi.fn(async () => {
          throw new InvalidDashboardNotificationCursorError();
        }),
      }).app,
    ).get('/v1/dashboard/notifications?cursor=opaque');
    expect(notificationResponse.status).toBe(422);
    expect(notificationResponse.body).toEqual({
      error: {
        code: 'validation_error',
        message: 'Invalid dashboard notification cursor',
      },
    });

    const dlqResponse = await request(
      setup({
        listDlq: vi.fn(async () => {
          throw new InvalidDashboardDlqCursorError();
        }),
      }).app,
    ).get('/v1/dashboard/dlq?cursor=opaque');
    expect(dlqResponse.status).toBe(422);
    expect(dlqResponse.body).toEqual({
      error: { code: 'validation_error', message: 'Invalid dashboard DLQ cursor' },
    });
  });

  it('uses the same 404 for missing and out-of-scope notification details', async () => {
    const missing = setup({
      getNotification: vi.fn(async () => {
        throw new DashboardNotificationNotFoundError();
      }),
    });
    const response = await request(missing.app).get(
      `/v1/dashboard/notifications/${notificationId}`,
    );
    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: 'not_found', message: 'Dashboard notification not found' },
    });
    expect(response.text).not.toContain(notificationId);
  });

  it('rejects invalid detail IDs without calling persistence', async () => {
    const { app, dashboard } = setup();
    const response = await request(app).get('/v1/dashboard/notifications/not-a-uuid');
    expect(response.status).toBe(422);
    expect(dashboard.getNotification).not.toHaveBeenCalled();
  });

  it('sanitizes unexpected handler errors', async () => {
    const sensitive = 'postgres://private-user:private-password@internal-host/database';
    const { app } = setup({
      summary: vi.fn(async () => Promise.reject(new Error(sensitive))),
    });
    const response = await request(app).get('/v1/dashboard/summary');
    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: 'internal_error', message: 'Internal server error' },
    });
    expect(response.text).not.toContain(sensitive);
    expect(response.text).not.toContain('stack');
  });

  it('recursively strips sensitive fields added by an injectable handler', async () => {
    const secret = 'handler-injected-sensitive-value';
    const maliciousDelivery = {
      ...notification.deliveries[0]!,
      provider: secret,
      providerMessageId: secret,
      lastError: secret,
      recipient: { email: secret, phone: secret },
    };
    const { app } = setup({
      summary: vi.fn(
        async () =>
          ({ sentToday: 1, inFlight: 2, failed: 3, dlq: 4, databaseUrl: secret }) as never,
      ),
      listNotifications: vi.fn(
        async () =>
          ({
            items: [
              {
                ...notification,
                userId: secret,
                payload: { secret },
                deliveries: [maliciousDelivery],
              },
            ],
            nextCursor: null,
            rawError: secret,
          }) as never,
      ),
      getNotification: vi.fn(
        async () =>
          ({
            ...notification,
            userId: secret,
            payload: { secret },
            deliveries: [
              {
                ...maliciousDelivery,
                timeline: [
                  {
                    status: DeliveryStatus.RETRYING,
                    createdAt,
                    reason: 'delivery_retry_scheduled',
                    errorClassification: 'UnexpectedError',
                    detail: { rawError: secret, provider: secret },
                  },
                ],
              },
            ],
          }) as never,
      ),
      listDlq: vi.fn(
        async () =>
          ({
            items: [
              {
                deliveryId,
                notificationId,
                event: 'invoice.paid',
                channel: Channel.EMAIL,
                status: DeliveryStatus.DLQ,
                attempts: 3,
                createdAt,
                updatedAt: createdAt,
                reason: 'delivery_dead_lettered',
                errorClassification: 'UnexpectedError',
                provider: secret,
                lastError: secret,
                notification: { payload: secret, userId: secret },
              },
            ],
            nextCursor: null,
            credentials: secret,
          }) as never,
      ),
    });

    const responses = await Promise.all([
      request(app).get('/v1/dashboard/summary'),
      request(app).get('/v1/dashboard/notifications'),
      request(app).get(`/v1/dashboard/notifications/${notificationId}`),
      request(app).get('/v1/dashboard/dlq'),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([200, 200, 200, 200]);
    const serialized = JSON.stringify(responses.map(({ body }) => body));
    expect(serialized).not.toContain(secret);
    for (const key of [
      'databaseUrl',
      'userId',
      'payload',
      'provider',
      'providerMessageId',
      'lastError',
      'recipient',
      'detail',
      'rawError',
      'notification',
      'credentials',
    ]) {
      expect(serialized).not.toContain(`"${key}"`);
    }
  });

  it('returns a sanitized 500 when an injectable handler violates the public schema', async () => {
    const secret = 'invalid-handler-output-secret';
    const summaryApp = setup({
      summary: vi.fn(
        async () => ({ sentToday: -1, inFlight: 0, failed: 0, dlq: 0, rawError: secret }) as never,
      ),
    }).app;
    const cursorApp = setup({
      listNotifications: vi.fn(async () => ({ items: [], nextCursor: secret }) as never),
    }).app;
    for (const response of [
      await request(summaryApp).get('/v1/dashboard/summary'),
      await request(cursorApp).get('/v1/dashboard/notifications'),
    ]) {
      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: { code: 'internal_error', message: 'Internal server error' },
      });
      expect(response.text).not.toContain(secret);
      expect(response.text).not.toContain('Zod');
    }
  });

  it('does not expose dashboard routes when handlers are not configured', async () => {
    const app = createApp({
      apiKey,
      notify: vi.fn(async () => ({ notificationId, replayed: false })),
    });
    expect((await request(app).get('/v1/dashboard/summary')).status).toBe(404);
  });
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('optional dashboard static assets', () => {
  it('serves hashed assets immutably, revalidates stable files, and does not cache HTML', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'notifyhub-dashboard-'));
    temporaryDirectories.push(directory);
    await mkdir(path.join(directory, 'assets'));
    await writeFile(path.join(directory, 'index.html'), '<main>NotifyHub dashboard</main>');
    await writeFile(path.join(directory, 'social-dashboard.png'), 'synthetic social card');
    await writeFile(path.join(directory, 'assets', 'app.js'), 'globalThis.dashboard = true;');
    const app = createApp({
      apiKey,
      notify: vi.fn(async () => ({ notificationId, replayed: false })),
      dashboardAssetsDirectory: directory,
    });

    const root = await request(app).get('/dashboard');
    expect(root.status).toBe(200);
    expect(root.text).toContain('NotifyHub dashboard');
    expect(root.headers['cache-control']).toContain('no-cache');

    const fallback = await request(app).get('/dashboard/notifications/example');
    expect(fallback.status).toBe(200);
    expect(fallback.text).toContain('NotifyHub dashboard');
    expect(fallback.headers['cache-control']).toContain('no-cache');

    const asset = await request(app).get('/dashboard/assets/app.js');
    expect(asset.status).toBe(200);
    expect(asset.headers['cache-control']).toContain('immutable');

    const stable = await request(app).get('/dashboard/social-dashboard.png');
    expect(stable.status).toBe(200);
    expect(stable.headers['cache-control']).toBe('public, max-age=300, must-revalidate');

    const directIndex = await request(app).get('/dashboard/index.html');
    expect(directIndex.headers['cache-control']).toContain('no-cache');
  });

  it('returns a sanitized 503 when the configured bundle is absent', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'notifyhub-dashboard-empty-'));
    temporaryDirectories.push(directory);
    const app = createApp({
      apiKey,
      notify: vi.fn(async () => ({ notificationId, replayed: false })),
      dashboardAssetsDirectory: directory,
    });
    const response = await request(app).get('/dashboard');
    expect(response.status).toBe(503);
    expect(response.text).toBe('Dashboard bundle is unavailable.');
    expect(response.text).not.toContain(directory);
  });
});
