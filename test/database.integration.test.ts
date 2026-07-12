import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  Channel,
  createPrismaClient,
  DeliveryStatus,
  DigestBatchStatus,
  NotificationStatus,
  type PrismaClient,
} from '../packages/core/src/index.js';

const executeFile = promisify(execFile);
const prismaExecutable =
  process.platform === 'win32' ? 'node_modules/.bin/prisma.cmd' : 'node_modules/.bin/prisma';

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

afterAll(async () => {
  await prisma?.$disconnect();
  await container?.stop();
});

describe.sequential('PostgreSQL persistence', () => {
  it('migrates the complete schema and persists a connected record graph with defaults', async () => {
    const user = await prisma.user.create({
      data: { id: 'user-graph', email: 'graph@example.test' },
    });
    const notification = await prisma.notification.create({
      data: {
        userId: user.id,
        event: 'comment.created',
        payload: { commentId: 'comment-1', nested: { important: true } },
      },
    });
    const delivery = await prisma.delivery.create({
      data: {
        notificationId: notification.id,
        channel: Channel.EMAIL,
        provider: 'mailpit',
        events: {
          create: { status: DeliveryStatus.QUEUED, detail: { reason: 'routed' } },
        },
      },
      include: { events: true },
    });

    expect(user.timezone).toBe('UTC');
    expect(notification.status).toBe(NotificationStatus.ACCEPTED);
    expect(notification.payload).toEqual({ commentId: 'comment-1', nested: { important: true } });
    expect(delivery).toMatchObject({ status: DeliveryStatus.QUEUED, attempts: 0 });
    expect(delivery.events[0]?.detail).toEqual({ reason: 'routed' });
  });

  it('enforces idempotency only for supplied keys', async () => {
    const user = await prisma.user.create({
      data: { id: 'user-idempotency', email: 'idempotency@example.test' },
    });
    const createNotification = (idempotencyKey?: string) =>
      prisma.notification.create({
        data: {
          userId: user.id,
          event: 'comment.created',
          payload: {},
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        },
      });

    await createNotification();
    await createNotification();
    await createNotification('stable-key');
    await expect(createNotification('stable-key')).rejects.toMatchObject({ code: 'P2002' });
  });

  it('enforces template, preference, and quiet-hours uniqueness', async () => {
    const user = await prisma.user.create({
      data: { id: 'user-settings', email: 'settings@example.test' },
    });
    const template = {
      event: 'comment.created',
      channel: Channel.EMAIL,
      locale: 'en',
      body: 'A comment arrived',
    } as const;
    const preference = {
      userId: user.id,
      channel: Channel.EMAIL,
      category: 'comment.*',
    } as const;

    await prisma.template.create({ data: template });
    await expect(prisma.template.create({ data: template })).rejects.toMatchObject({
      code: 'P2002',
    });
    await prisma.preference.create({ data: preference });
    await expect(prisma.preference.create({ data: preference })).rejects.toMatchObject({
      code: 'P2002',
    });
    await prisma.quietHours.create({
      data: { userId: user.id, startMinute: 1320, endMinute: 480 },
    });
    await expect(
      prisma.quietHours.create({ data: { userId: user.id, startMinute: 0, endMinute: 60 } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('allows historical digest batches but only one open batch per routing key', async () => {
    const user = await prisma.user.create({
      data: { id: 'user-digest', email: 'digest@example.test' },
    });
    const routingKey = {
      userId: user.id,
      event: 'comment.created',
      channel: Channel.EMAIL,
      windowEndsAt: new Date(Date.now() + 600_000),
    } as const;

    await prisma.digestBatch.create({ data: { ...routingKey, status: DigestBatchStatus.FLUSHED } });
    await prisma.digestBatch.create({ data: { ...routingKey, status: DigestBatchStatus.FLUSHED } });
    await prisma.digestBatch.create({ data: routingKey });
    await expect(prisma.digestBatch.create({ data: routingKey })).rejects.toMatchObject({
      code: 'P2002',
    });
  });

  it('prevents duplicate digest membership and inbox messages and returns newest inbox rows first', async () => {
    const user = await prisma.user.create({
      data: { id: 'user-inbox', email: 'inbox@example.test' },
    });
    const notification = await prisma.notification.create({
      data: { userId: user.id, event: 'comment.created', payload: {} },
    });
    const batch = await prisma.digestBatch.create({
      data: {
        userId: user.id,
        event: 'comment.created',
        channel: Channel.EMAIL,
        windowEndsAt: new Date(Date.now() + 600_000),
      },
    });

    const digestItem = { batchId: batch.id, notificationId: notification.id };
    await prisma.digestItem.create({ data: digestItem });
    await expect(prisma.digestItem.create({ data: digestItem })).rejects.toMatchObject({
      code: 'P2002',
    });

    const inboxMessage = {
      userId: user.id,
      notificationId: notification.id,
      title: 'New comment',
      body: 'A comment arrived',
    };
    const first = await prisma.inboxMessage.create({ data: inboxMessage });
    await expect(prisma.inboxMessage.create({ data: inboxMessage })).rejects.toMatchObject({
      code: 'P2002',
    });

    const secondNotification = await prisma.notification.create({
      data: { userId: user.id, event: 'mention.created', payload: {} },
    });
    const second = await prisma.inboxMessage.create({
      data: {
        userId: user.id,
        notificationId: secondNotification.id,
        title: 'New mention',
        body: 'You were mentioned',
        createdAt: new Date(first.createdAt.getTime() + 1_000),
      },
    });
    const messages = await prisma.inboxMessage.findMany({
      where: { userId: user.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    expect(messages.map(({ id }) => id)).toEqual([second.id, first.id]);
  });
});
