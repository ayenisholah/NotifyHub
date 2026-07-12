import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Redis } from 'ioredis';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  Channel,
  createChannelQueueProducer,
  createDelivery,
  createPrismaClient,
  DeliveryStatus,
  type PrismaClient,
} from '../packages/core/src/index.js';
import {
  createInAppDeliveryHandler,
  createInboxPublisher,
  createInAppWorker,
  INBOX_MESSAGE_CREATED,
  INBOX_PUBSUB_CHANNEL,
  InAppDeliveryError,
  InAppDeliveryNotFoundError,
  InAppTemplateNotFoundError,
  type InboxMessageCreatedEvent,
} from '../packages/workers/src/index.js';

const executeFile = promisify(execFile);
const prismaExecutable =
  process.platform === 'win32' ? 'node_modules/.bin/prisma.cmd' : 'node_modules/.bin/prisma';
let postgres: StartedPostgreSqlContainer;
let redis: StartedTestContainer;
let prisma: PrismaClient;

beforeAll(async () => {
  [postgres, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:18').start(),
    new GenericContainer('redis:8-alpine').withExposedPorts(6379).start(),
  ]);
  const databaseUrl = postgres.getConnectionUri();
  await executeFile(prismaExecutable, ['migrate', 'deploy'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  prisma = createPrismaClient(databaseUrl);
  await prisma.$connect();
}, 120_000);

beforeEach(async () => {
  await prisma.template.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.user.deleteMany();
});

afterAll(async () => {
  await prisma?.$disconnect();
  await Promise.all([postgres?.stop(), redis?.stop()]);
});

async function createInAppDelivery(label: string) {
  const user = await prisma.user.create({
    data: { id: `in-app-${label}`, email: `${label}@example.test` },
  });
  const notification = await prisma.notification.create({
    data: {
      userId: user.id,
      event: 'comment.created',
      payload: { author: 'Ada', text: '<hello>' },
    },
  });
  await prisma.template.create({
    data: {
      event: notification.event,
      channel: Channel.IN_APP,
      subject: 'New comment from {{payload.author}}',
      body: '{{payload.text}} for {{user.email}}',
    },
  });
  return createDelivery(prisma, {
    notificationId: notification.id,
    channel: Channel.IN_APP,
    provider: 'internal',
  });
}

async function waitFor<T>(read: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for in-app worker');
}

describe.sequential('restart-safe in-app delivery handler', () => {
  it('atomically creates one inbox message and a complete delivery timeline', async () => {
    const delivery = await createInAppDelivery('complete');
    const publish = vi.fn(async () => undefined);
    const handler = createInAppDeliveryHandler(prisma, { publish });

    const event = await handler(delivery.id);

    const persisted = await prisma.delivery.findUniqueOrThrow({
      where: { id: delivery.id },
      include: {
        events: { orderBy: { id: 'asc' } },
        notification: { include: { inboxMessage: true } },
      },
    });
    expect(persisted).toMatchObject({
      status: DeliveryStatus.SENT,
      attempts: 1,
      providerMessageId: persisted.notification.inboxMessage?.id,
      events: [
        { status: DeliveryStatus.QUEUED },
        { status: DeliveryStatus.PROCESSING, detail: { reason: 'in_app_processing' } },
        { status: DeliveryStatus.SENT, detail: { reason: 'inbox_persisted' } },
      ],
      notification: {
        inboxMessage: {
          title: 'New comment from Ada',
          body: '<hello> for complete@example.test',
        },
      },
    });
    expect(event).toMatchObject({
      type: INBOX_MESSAGE_CREATED,
      userId: 'in-app-complete',
      message: { id: persisted.notification.inboxMessage?.id },
    });
    expect(publish).toHaveBeenCalledWith(event);
  });

  it('keeps persistence complete after publish failure and republishes on replay', async () => {
    const delivery = await createInAppDelivery('replay');
    const publish = vi
      .fn<(event: InboxMessageCreatedEvent) => Promise<void>>()
      .mockRejectedValueOnce(new Error('redis unavailable'))
      .mockResolvedValue(undefined);
    const handler = createInAppDeliveryHandler(prisma, { publish });

    await expect(handler(delivery.id)).rejects.toThrow('redis unavailable');
    await expect(handler(delivery.id)).resolves.toMatchObject({ type: INBOX_MESSAGE_CREATED });
    expect(
      await prisma.inboxMessage.count({
        where: { notification: { deliveries: { some: { id: delivery.id } } } },
      }),
    ).toBe(1);
    expect(await prisma.deliveryEvent.count({ where: { deliveryId: delivery.id } })).toBe(3);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1]?.[0]).toEqual(publish.mock.calls[0]?.[0]);
  });

  it('stabilizes concurrent executions without duplicate rows or events', async () => {
    const delivery = await createInAppDelivery('concurrent');
    const handler = createInAppDeliveryHandler(prisma, { publish: async () => undefined });

    const results = await Promise.all(Array.from({ length: 6 }, () => handler(delivery.id)));

    expect(new Set(results.map(({ message }) => message.id)).size).toBe(1);
    expect(await prisma.inboxMessage.count()).toBe(1);
    expect(await prisma.deliveryEvent.count({ where: { deliveryId: delivery.id } })).toBe(3);
  });

  it('recovers a processing delivery and rejects invalid inputs', async () => {
    const delivery = await createInAppDelivery('processing');
    await prisma.delivery.update({
      where: { id: delivery.id },
      data: { status: DeliveryStatus.PROCESSING, attempts: 1 },
    });
    const handler = createInAppDeliveryHandler(prisma, { publish: async () => undefined });
    await expect(handler(delivery.id)).resolves.toMatchObject({ type: INBOX_MESSAGE_CREATED });
    expect(await prisma.deliveryEvent.count({ where: { deliveryId: delivery.id } })).toBe(2);

    await expect(handler('00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(
      InAppDeliveryNotFoundError,
    );
    const wrongChannel = await createDelivery(prisma, {
      notificationId: (await prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id } }))
        .notificationId,
      channel: Channel.EMAIL,
      provider: 'mailpit',
    });
    await expect(handler(wrongChannel.id)).rejects.toBeInstanceOf(InAppDeliveryError);
  });

  it('rolls back when the routed template is missing at execution time', async () => {
    const delivery = await createInAppDelivery('missing-template');
    await prisma.template.deleteMany();
    const handler = createInAppDeliveryHandler(prisma, { publish: async () => undefined });

    await expect(handler(delivery.id)).rejects.toBeInstanceOf(InAppTemplateNotFoundError);
    await expect(
      prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id } }),
    ).resolves.toMatchObject({ status: DeliveryStatus.QUEUED });
    expect(await prisma.inboxMessage.count()).toBe(0);
    expect(await prisma.deliveryEvent.count({ where: { deliveryId: delivery.id } })).toBe(1);
  });
});

describe.sequential('in-app BullMQ worker and Redis publisher', () => {
  it('consumes a stable channel job and publishes the committed inbox envelope', async () => {
    const delivery = await createInAppDelivery('worker');
    const redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
    const publisher = createInboxPublisher(redisUrl);
    const subscriber = new Redis(redisUrl);
    const messages: InboxMessageCreatedEvent[] = [];
    subscriber.on('message', (_channel, message) =>
      messages.push(JSON.parse(message) as InboxMessageCreatedEvent),
    );
    await subscriber.subscribe(INBOX_PUBSUB_CHANNEL);
    const handler = createInAppDeliveryHandler(prisma, publisher);
    const worker = createInAppWorker(redisUrl, handler);
    const producer = createChannelQueueProducer(redisUrl);

    try {
      await producer.enqueue(Channel.IN_APP, delivery.id);
      const event = await waitFor(async () => messages[0] ?? null);
      const persisted = await prisma.inboxMessage.findUniqueOrThrow({
        where: { notificationId: delivery.notificationId },
      });
      expect(event).toMatchObject({
        type: INBOX_MESSAGE_CREATED,
        userId: 'in-app-worker',
        message: { id: persisted.id, notificationId: delivery.notificationId },
      });
      await expect(
        prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id } }),
      ).resolves.toMatchObject({ status: DeliveryStatus.SENT });
    } finally {
      await worker.close();
      await producer.close();
      await publisher.close();
      await subscriber.quit();
    }
  });
});
