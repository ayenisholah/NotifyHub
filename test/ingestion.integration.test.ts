import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp, createPersistentNotifyHandler } from '../packages/api/src/index.js';
import { createPrismaClient, type PrismaClient } from '../packages/core/src/index.js';

const executeFile = promisify(execFile);
const prismaExecutable =
  process.platform === 'win32' ? 'node_modules/.bin/prisma.cmd' : 'node_modules/.bin/prisma';
const apiKey = 'integration-api-key-with-enough-entropy';
const authorization = `Bearer ${apiKey}`;

let container: StartedPostgreSqlContainer;
let prisma: PrismaClient;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  const databaseUrl = container.getConnectionUri();
  await executeFile(prismaExecutable, ['migrate', 'deploy'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  prisma = createPrismaClient(databaseUrl);
  await prisma.$connect();
}, 120_000);

beforeEach(async () => {
  await prisma.notification.deleteMany();
  await prisma.user.deleteMany();
  await prisma.user.create({ data: { id: 'user-1', email: 'user-1@example.test' } });
});

afterAll(async () => {
  await prisma?.$disconnect();
  await container?.stop();
});

function body(idempotencyKey?: string) {
  return {
    userId: 'user-1',
    event: 'invoice.paid',
    payload: { invoiceId: 'invoice-1' },
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  };
}

async function post(app: ReturnType<typeof createApp>, value: ReturnType<typeof body>) {
  return request(app).post('/v1/notify').set('Authorization', authorization).send(value);
}

describe.sequential('persist-first notification ingestion', () => {
  it('persists before enqueueing and returns 202 for a new request', async () => {
    const enqueue = vi.fn(async (notificationId: string) => {
      await expect(
        prisma.notification.findUnique({ where: { id: notificationId } }),
      ).resolves.toMatchObject({
        status: 'ACCEPTED',
      });
    });
    const app = createApp({
      apiKey,
      notify: createPersistentNotifyHandler(prisma, { enqueue }),
    });

    const response = await post(app, body());

    expect(response.status).toBe(202);
    expect(enqueue).toHaveBeenCalledWith(response.body.notificationId);
    expect(await prisma.notification.count()).toBe(1);
  });

  it('coalesces concurrent keyed requests into one row and one enqueue', async () => {
    const enqueue = vi.fn(async () => undefined);
    const app = createApp({ apiKey, notify: createPersistentNotifyHandler(prisma, { enqueue }) });

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => post(app, body('same-key'))),
    );

    expect(responses.map(({ status }) => status).sort()).toEqual([
      200, 200, 200, 200, 200, 200, 200, 202,
    ]);
    expect(new Set(responses.map(({ body: value }) => value.notificationId)).size).toBe(1);
    expect(await prisma.notification.count()).toBe(1);
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('returns the original notification when a key is reused with different data', async () => {
    const enqueue = vi.fn(async () => undefined);
    const app = createApp({ apiKey, notify: createPersistentNotifyHandler(prisma, { enqueue }) });
    const first = await post(app, body('stable-key'));
    const replay = await post(app, {
      ...body('stable-key'),
      event: 'different.event',
      payload: { invoiceId: 'different' },
    });

    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    await expect(
      prisma.notification.findUniqueOrThrow({ where: { id: first.body.notificationId } }),
    ).resolves.toMatchObject({
      event: 'invoice.paid',
      payload: { invoiceId: 'invoice-1' },
    });
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('keeps unkeyed requests independent', async () => {
    const enqueue = vi.fn(async () => undefined);
    const app = createApp({ apiKey, notify: createPersistentNotifyHandler(prisma, { enqueue }) });
    const responses = await Promise.all([post(app, body()), post(app, body())]);

    expect(responses.map(({ status }) => status)).toEqual([202, 202]);
    expect(await prisma.notification.count()).toBe(2);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('retains the accepted row when enqueueing fails', async () => {
    const app = createApp({
      apiKey,
      notify: createPersistentNotifyHandler(prisma, {
        enqueue: async () => Promise.reject(new Error('redis secret')),
      }),
    });

    const response = await post(app, body('queue-failure'));

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: 'internal_error', message: 'Internal server error' },
    });
    await expect(
      prisma.notification.findUnique({ where: { idempotencyKey: 'queue-failure' } }),
    ).resolves.toMatchObject({ status: 'ACCEPTED' });
  });

  it('returns a sanitized 500 for an unknown user', async () => {
    const enqueue = vi.fn(async () => undefined);
    const app = createApp({ apiKey, notify: createPersistentNotifyHandler(prisma, { enqueue }) });

    const response = await post(app, { ...body(), userId: 'unknown-user' });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: 'internal_error', message: 'Internal server error' },
    });
    expect(response.text).not.toContain('unknown-user');
    expect(enqueue).not.toHaveBeenCalled();
  });
});
