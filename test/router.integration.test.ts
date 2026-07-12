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
  ROUTING_REASONS,
  ROUTE_QUEUE_NAME,
  type ChannelJobData,
  type PrismaClient,
} from '../packages/core/src/index.js';
import {
  createRouteNotificationHandler,
  createRouteWorker,
  NotificationNotFoundError,
  NO_TEMPLATES_REASON,
  PREFERENCES_DISABLED_REASON,
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

async function createNotification(label: string, event = 'invoice.paid', payload = {}) {
  const user = await prisma.user.create({
    data: { id: `router-${label}`, email: `router-${label}@example.test` },
  });
  return prisma.notification.create({ data: { userId: user.id, event, payload } });
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

  it('resolves global, prefix, and exact preferences independently by channel', async () => {
    const notification = await createNotification('precedence', 'comment.reply.created');
    await prisma.template.createMany({
      data: Object.values(Channel).map((channel) => ({
        event: notification.event,
        channel,
        body: channel,
      })),
    });
    await prisma.preference.createMany({
      data: [
        { userId: notification.userId, channel: Channel.EMAIL, category: '*', enabled: false },
        {
          userId: notification.userId,
          channel: Channel.EMAIL,
          category: 'comment.*',
          enabled: true,
        },
        {
          userId: notification.userId,
          channel: Channel.EMAIL,
          category: 'comment.reply.*',
          enabled: false,
        },
        {
          userId: notification.userId,
          channel: Channel.EMAIL,
          category: notification.event,
          enabled: true,
        },
        { userId: notification.userId, channel: Channel.SMS, category: '*', enabled: true },
        {
          userId: notification.userId,
          channel: Channel.SMS,
          category: notification.event,
          enabled: false,
        },
        { userId: notification.userId, channel: Channel.IN_APP, category: '*', enabled: false },
        {
          userId: notification.userId,
          channel: Channel.IN_APP,
          category: 'comment.*',
          enabled: true,
        },
      ],
    });
    const enqueue = vi.fn(async () => undefined);

    await createRouteNotificationHandler(prisma, { enqueue }, providers)(notification.id);

    const deliveries = await prisma.delivery.findMany({
      where: { notificationId: notification.id },
      include: { events: true },
      orderBy: { channel: 'asc' },
    });
    expect(deliveries.map(({ channel }) => channel)).toEqual([Channel.EMAIL, Channel.IN_APP]);
    expect(deliveries.map(({ events }) => events[0]?.detail)).toEqual([
      { locale: 'en', preferenceCategory: notification.event, reason: ROUTING_REASONS.IMMEDIATE },
      { locale: 'en', preferenceCategory: 'comment.*', reason: ROUTING_REASONS.IMMEDIATE },
    ]);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('makes fully disabled templates an explained no-op, even when critical', async () => {
    const notification = await createNotification('disabled', 'security.alert', { critical: true });
    await prisma.template.createMany({
      data: [
        { event: notification.event, channel: Channel.EMAIL, body: 'Email' },
        { event: notification.event, channel: Channel.IN_APP, body: 'Inbox' },
      ],
    });
    await prisma.preference.createMany({
      data: [Channel.EMAIL, Channel.IN_APP].map((channel) => ({
        userId: notification.userId,
        channel,
        category: '*',
        enabled: false,
      })),
    });
    const enqueue = vi.fn(async () => undefined);
    const route = createRouteNotificationHandler(prisma, { enqueue }, providers);

    await expect(route(notification.id)).resolves.toEqual({
      status: NotificationStatus.NO_OP,
      deliveryIds: [],
    });
    await expect(
      prisma.notification.findUniqueOrThrow({ where: { id: notification.id } }),
    ).resolves.toMatchObject({
      status: NotificationStatus.NO_OP,
      noOpReason: PREFERENCES_DISABLED_REASON,
    });
    expect(await prisma.delivery.count({ where: { notificationId: notification.id } })).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();

    await prisma.preference.updateMany({
      where: { userId: notification.userId },
      data: { enabled: true },
    });
    await expect(route(notification.id)).resolves.toEqual({
      status: NotificationStatus.NO_OP,
      deliveryIds: [],
    });
    expect(await prisma.delivery.count({ where: { notificationId: notification.id } })).toBe(0);
  });

  it('does not rewrite routed channels after preferences change', async () => {
    const notification = await createNotification('stable');
    await prisma.template.createMany({
      data: [
        { event: notification.event, channel: Channel.EMAIL, body: 'Email' },
        { event: notification.event, channel: Channel.SMS, body: 'SMS' },
      ],
    });
    await prisma.preference.create({
      data: { userId: notification.userId, channel: Channel.SMS, category: '*', enabled: false },
    });
    const route = createRouteNotificationHandler(
      prisma,
      { enqueue: async () => undefined },
      providers,
    );
    const first = await route(notification.id);
    await prisma.preference.updateMany({
      where: { userId: notification.userId },
      data: { enabled: true },
    });
    const replay = await route(notification.id);

    expect(replay).toEqual(first);
    expect(
      await prisma.delivery.findMany({
        where: { notificationId: notification.id },
        select: { channel: true },
      }),
    ).toEqual([{ channel: Channel.EMAIL }]);
  });

  it('schedules interruptive channels during quiet hours while in-app remains immediate', async () => {
    const notification = await createNotification('quiet', 'comment.created');
    await prisma.user.update({
      where: { id: notification.userId },
      data: {
        timezone: 'Africa/Lagos',
        quietHours: { create: { startMinute: 22 * 60, endMinute: 8 * 60 } },
      },
    });
    await prisma.template.createMany({
      data: Object.values(Channel).map((channel) => ({
        event: notification.event,
        channel,
        body: channel,
      })),
    });
    const enqueue = vi.fn(async () => undefined);
    const route = createRouteNotificationHandler(
      prisma,
      { enqueue },
      providers,
      () => new Date('2026-07-12T22:30:00Z'),
    );

    const first = await route(notification.id);
    const deliveries = await prisma.delivery.findMany({
      where: { notificationId: notification.id },
      include: { events: true },
      orderBy: { channel: 'asc' },
    });
    expect(deliveries).toHaveLength(3);
    expect(deliveries).toEqual(
      expect.arrayContaining([
        {
          channel: Channel.EMAIL,
          status: 'SCHEDULED',
          scheduledFor: new Date('2026-07-13T07:00:00Z'),
          events: [
            {
              status: 'SCHEDULED',
              detail: {
                reason: 'quiet_hours',
                timezone: 'Africa/Lagos',
                scheduledFor: '2026-07-13T07:00:00.000Z',
              },
            },
          ],
        },
        {
          channel: Channel.IN_APP,
          status: 'QUEUED',
          scheduledFor: null,
          events: [{ status: 'QUEUED' }],
        },
        {
          channel: Channel.SMS,
          status: 'SCHEDULED',
          scheduledFor: new Date('2026-07-13T07:00:00Z'),
          events: [{ status: 'SCHEDULED' }],
        },
      ]),
    );
    expect(enqueue).toHaveBeenCalledTimes(3);
    expect(enqueue.mock.calls.map(([channel, , scheduledFor]) => [channel, scheduledFor])).toEqual(
      expect.arrayContaining([
        [Channel.EMAIL, new Date('2026-07-13T07:00:00Z')],
        [Channel.IN_APP, undefined],
        [Channel.SMS, new Date('2026-07-13T07:00:00Z')],
      ]),
    );

    await prisma.user.update({
      where: { id: notification.userId },
      data: { timezone: 'UTC', quietHours: { delete: true } },
    });
    expect(await route(notification.id)).toEqual(first);
    expect(
      await prisma.deliveryEvent.count({
        where: { delivery: { notificationId: notification.id } },
      }),
    ).toBe(3);
  });

  it('lets critical interruptive deliveries bypass quiet hours', async () => {
    const notification = await createNotification('critical-quiet', 'security.alert', {
      critical: true,
    });
    await prisma.user.update({
      where: { id: notification.userId },
      data: {
        timezone: 'Invalid/Timezone',
        quietHours: { create: { startMinute: 0, endMinute: 8 * 60 } },
      },
    });
    await prisma.template.create({
      data: { event: notification.event, channel: Channel.EMAIL, body: 'Email' },
    });
    await createRouteNotificationHandler(
      prisma,
      { enqueue: async () => undefined },
      providers,
      () => new Date('2026-07-12T03:00:00Z'),
    )(notification.id);

    await expect(
      prisma.delivery.findFirstOrThrow({
        where: { notificationId: notification.id },
        include: { events: true },
      }),
    ).resolves.toMatchObject({
      status: 'QUEUED',
      scheduledFor: null,
      events: [{ detail: { reason: 'critical' } }],
    });
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
