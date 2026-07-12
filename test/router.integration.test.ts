import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Queue } from 'bullmq';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  Channel,
  CHANNEL_QUEUE_NAMES,
  createChannelQueueProducer,
  createPrismaClient,
  createRouteQueueProducer,
  NotificationStatus,
  ROUTE_QUEUE_NAME,
  type ChannelJobData,
  type PrismaClient,
} from '../packages/core/src/index.js';
import {
  createRouteNotificationHandler,
  createRouteWorker,
  NotificationNotFoundError,
  NO_TEMPLATES_REASON,
  type ProviderMapping,
} from '../packages/workers/src/index.js';

const executeFile = promisify(execFile);
const prismaExecutable =
  process.platform === 'win32' ? 'node_modules/.bin/prisma.cmd' : 'node_modules/.bin/prisma';
const providers: ProviderMapping = {
  [Channel.EMAIL]: 'mailpit',
  [Channel.SMS]: 'mock-sms',
  [Channel.IN_APP]: 'internal',
};

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

async function createNotification(label: string, event = 'invoice.paid') {
  const user = await prisma.user.create({
    data: { id: `router-${label}`, email: `router-${label}@example.test` },
  });
  return prisma.notification.create({ data: { userId: user.id, event, payload: {} } });
}

async function waitFor<T>(read: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for routed data');
}

describe.sequential('template-based notification router', () => {
  it('creates deliveries only for matching English templates and enqueues after commit', async () => {
    const notification = await createNotification('templates');
    await prisma.template.createMany({
      data: [
        { event: notification.event, channel: Channel.EMAIL, locale: 'en', body: 'Email' },
        { event: notification.event, channel: Channel.IN_APP, locale: 'en', body: 'Inbox' },
        { event: notification.event, channel: Channel.SMS, locale: 'fr', body: 'French SMS' },
        { event: 'other.event', channel: Channel.SMS, locale: 'en', body: 'Other' },
      ],
    });
    const enqueue = vi.fn(async (_channel: Channel, deliveryId: string) => {
      await expect(
        prisma.delivery.findUnique({ where: { id: deliveryId }, include: { notification: true } }),
      ).resolves.toMatchObject({
        status: 'QUEUED',
        notification: { status: NotificationStatus.ROUTED },
      });
    });
    const route = createRouteNotificationHandler(prisma, { enqueue }, providers);

    const result = await route(notification.id);

    expect(result.status).toBe(NotificationStatus.ROUTED);
    expect(enqueue).toHaveBeenCalledTimes(2);
    const deliveries = await prisma.delivery.findMany({
      where: { notificationId: notification.id },
      include: { events: true },
      orderBy: { channel: 'asc' },
    });
    expect(deliveries).toMatchObject([
      { channel: Channel.EMAIL, provider: 'mailpit', events: [{ status: 'QUEUED' }] },
      { channel: Channel.IN_APP, provider: 'internal', events: [{ status: 'QUEUED' }] },
    ]);
  });

  it('marks notifications with no matching template as an explained no-op', async () => {
    const notification = await createNotification('noop');
    await prisma.template.create({
      data: { event: notification.event, channel: Channel.EMAIL, locale: 'fr', body: 'French' },
    });
    const enqueue = vi.fn(async () => undefined);
    const route = createRouteNotificationHandler(prisma, { enqueue }, providers);

    const result = await route(notification.id);

    expect(result).toEqual({ status: NotificationStatus.NO_OP, deliveryIds: [] });
    await expect(
      prisma.notification.findUniqueOrThrow({ where: { id: notification.id } }),
    ).resolves.toMatchObject({
      status: NotificationStatus.NO_OP,
      noOpReason: NO_TEMPLATES_REASON,
    });
    expect(await prisma.delivery.count({ where: { notificationId: notification.id } })).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('routes repeated and concurrent executions without duplicate deliveries or events', async () => {
    const notification = await createNotification('concurrent');
    await prisma.template.create({
      data: { event: notification.event, channel: Channel.EMAIL, body: 'Email' },
    });
    const enqueue = vi.fn(async () => undefined);
    const route = createRouteNotificationHandler(prisma, { enqueue }, providers);

    const results = await Promise.all(Array.from({ length: 8 }, () => route(notification.id)));

    expect(new Set(results.flatMap(({ deliveryIds }) => deliveryIds)).size).toBe(1);
    const deliveries = await prisma.delivery.findMany({
      where: { notificationId: notification.id },
      include: { events: true },
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.events).toHaveLength(1);
  });

  it('retains routed rows after partial enqueue failure and reuses them on retry', async () => {
    const notification = await createNotification('recovery');
    await prisma.template.createMany({
      data: [
        { event: notification.event, channel: Channel.EMAIL, body: 'Email' },
        { event: notification.event, channel: Channel.SMS, body: 'SMS' },
      ],
    });
    let calls = 0;
    const enqueue = vi.fn(async () => {
      calls += 1;
      if (calls === 2) throw new Error('redis unavailable');
    });
    const route = createRouteNotificationHandler(prisma, { enqueue }, providers);

    await expect(route(notification.id)).rejects.toThrow('redis unavailable');
    const persisted = await prisma.delivery.findMany({
      where: { notificationId: notification.id },
      orderBy: { channel: 'asc' },
    });
    expect(persisted).toHaveLength(2);
    await expect(route(notification.id)).resolves.toEqual({
      status: NotificationStatus.ROUTED,
      deliveryIds: persisted.map(({ id }) => id),
    });
    expect(
      await prisma.deliveryEvent.count({
        where: { deliveryId: { in: persisted.map(({ id }) => id) } },
      }),
    ).toBe(2);
  });

  it('rejects missing notifications and enforces one delivery per channel', async () => {
    const route = createRouteNotificationHandler(
      prisma,
      { enqueue: async () => undefined },
      providers,
    );
    await expect(route('00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(
      NotificationNotFoundError,
    );

    const notification = await createNotification('unique');
    const data = {
      notificationId: notification.id,
      channel: Channel.EMAIL,
      provider: 'mailpit',
    } as const;
    await prisma.delivery.create({ data });
    await expect(prisma.delivery.create({ data })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('consumes a route job and creates a stable channel job without a channel worker', async () => {
    const notification = await createNotification('bullmq');
    await prisma.template.create({
      data: { event: notification.event, channel: Channel.EMAIL, body: 'Email' },
    });
    const redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
    const routeProducer = createRouteQueueProducer(redisUrl);
    const channelProducer = createChannelQueueProducer(redisUrl);
    const route = createRouteNotificationHandler(prisma, channelProducer, providers);
    const worker = createRouteWorker(redisUrl, route);
    const emailQueue = new Queue<ChannelJobData>(CHANNEL_QUEUE_NAMES[Channel.EMAIL], {
      connection: { host: redis.getHost(), port: redis.getMappedPort(6379) },
    });
    const routeQueue = new Queue(ROUTE_QUEUE_NAME, {
      connection: { host: redis.getHost(), port: redis.getMappedPort(6379) },
    });

    try {
      await routeProducer.enqueue(notification.id);
      const delivery = await waitFor(() =>
        prisma.delivery.findFirst({ where: { notificationId: notification.id } }),
      );
      const job = await waitFor(() => emailQueue.getJob(delivery.id));

      expect(job.id).toBe(delivery.id);
      expect(job.data).toEqual({ deliveryId: delivery.id });
      expect(await emailQueue.getWaitingCount()).toBe(1);
    } finally {
      await worker.close();
      await routeProducer.close();
      await channelProducer.close();
      await emailQueue.obliterate({ force: true });
      await routeQueue.obliterate({ force: true });
      await Promise.all([emailQueue.close(), routeQueue.close()]);
    }
  });
});
