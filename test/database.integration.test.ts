import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  Channel,
  createDelivery,
  createPrismaClient,
  DeliveryNotFoundError,
  DeliveryStatus,
  DeliveryTransitionConflictError,
  DigestBatchStatus,
  InvalidDeliveryStateError,
  NotificationStatus,
  transitionDelivery,
  type PrismaClient,
} from '../packages/core/src/index.js';
import { createRetentionStore } from '../packages/runtime/src/retention.js';

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

describe.sequential('atomic delivery lifecycle', () => {
  async function notificationFor(label: string) {
    const user = await prisma.user.create({
      data: { id: `lifecycle-${label}`, email: `lifecycle-${label}@example.test` },
    });
    return prisma.notification.create({
      data: { userId: user.id, event: 'lifecycle.test', payload: {} },
    });
  }

  it('creates queued and scheduled deliveries with matching initial events', async () => {
    const notification = await notificationFor('creation');
    const scheduledFor = new Date(Date.now() + 60_000);
    const queued = await createDelivery(prisma, {
      notificationId: notification.id,
      channel: Channel.EMAIL,
      provider: 'mailpit',
      detail: { reason: 'immediate' },
    });
    const scheduled = await createDelivery(prisma, {
      notificationId: notification.id,
      channel: Channel.SMS,
      provider: 'mock-sms',
      initialStatus: DeliveryStatus.SCHEDULED,
      scheduledFor,
      detail: { reason: 'quiet_hours' },
    });

    await expect(
      prisma.deliveryEvent.findMany({
        where: { deliveryId: { in: [queued.id, scheduled.id] } },
        orderBy: { id: 'asc' },
      }),
    ).resolves.toMatchObject([
      { deliveryId: queued.id, status: DeliveryStatus.QUEUED, detail: { reason: 'immediate' } },
      {
        deliveryId: scheduled.id,
        status: DeliveryStatus.SCHEDULED,
        detail: { reason: 'quiet_hours' },
      },
    ]);
    expect(scheduled.scheduledFor).toEqual(scheduledFor);
  });

  it('supports the complete forward transition graph with an ordered event history', async () => {
    const notification = await notificationFor('graph');
    const sent = await createDelivery(prisma, {
      notificationId: notification.id,
      channel: Channel.EMAIL,
      provider: 'mailpit',
    });
    await transitionDelivery(prisma, {
      deliveryId: sent.id,
      expectedStatus: DeliveryStatus.QUEUED,
      status: DeliveryStatus.PROCESSING,
      attempts: 1,
    });
    const completed = await transitionDelivery(prisma, {
      deliveryId: sent.id,
      expectedStatus: DeliveryStatus.PROCESSING,
      status: DeliveryStatus.SENT,
      attempts: 1,
      providerMessageId: 'provider-1',
    });

    const retried = await createDelivery(prisma, {
      notificationId: notification.id,
      channel: Channel.SMS,
      provider: 'mock-sms',
      initialStatus: DeliveryStatus.SCHEDULED,
      scheduledFor: new Date(Date.now() + 60_000),
    });
    await transitionDelivery(prisma, {
      deliveryId: retried.id,
      expectedStatus: DeliveryStatus.SCHEDULED,
      status: DeliveryStatus.PROCESSING,
      attempts: 1,
    });
    await transitionDelivery(prisma, {
      deliveryId: retried.id,
      expectedStatus: DeliveryStatus.PROCESSING,
      status: DeliveryStatus.RETRYING,
      attempts: 1,
      lastError: 'temporary',
    });
    await transitionDelivery(prisma, {
      deliveryId: retried.id,
      expectedStatus: DeliveryStatus.RETRYING,
      status: DeliveryStatus.PROCESSING,
      attempts: 2,
    });
    await transitionDelivery(prisma, {
      deliveryId: retried.id,
      expectedStatus: DeliveryStatus.PROCESSING,
      status: DeliveryStatus.FAILED,
      attempts: 2,
      lastError: 'exhausted',
    });
    const deadLettered = await transitionDelivery(prisma, {
      deliveryId: retried.id,
      expectedStatus: DeliveryStatus.FAILED,
      status: DeliveryStatus.DLQ,
      attempts: 2,
      lastError: 'exhausted',
    });

    expect(completed).toMatchObject({
      status: DeliveryStatus.SENT,
      attempts: 1,
      providerMessageId: 'provider-1',
    });
    expect(deadLettered).toMatchObject({
      status: DeliveryStatus.DLQ,
      attempts: 2,
      lastError: 'exhausted',
    });
    const events = await prisma.deliveryEvent.findMany({
      where: { deliveryId: retried.id },
      orderBy: { id: 'asc' },
    });
    expect(events.map(({ status }) => status)).toEqual([
      DeliveryStatus.SCHEDULED,
      DeliveryStatus.PROCESSING,
      DeliveryStatus.RETRYING,
      DeliveryStatus.PROCESSING,
      DeliveryStatus.FAILED,
      DeliveryStatus.DLQ,
    ]);
  });

  it('rejects missing, invalid, stale, and terminal transitions without new events', async () => {
    const notification = await notificationFor('rejections');
    const delivery = await createDelivery(prisma, {
      notificationId: notification.id,
      channel: Channel.EMAIL,
      provider: 'mailpit',
    });
    await expect(
      transitionDelivery(prisma, {
        deliveryId: '00000000-0000-0000-0000-000000000000',
        expectedStatus: DeliveryStatus.QUEUED,
        status: DeliveryStatus.PROCESSING,
      }),
    ).rejects.toBeInstanceOf(DeliveryNotFoundError);
    await expect(
      transitionDelivery(prisma, {
        deliveryId: delivery.id,
        expectedStatus: DeliveryStatus.QUEUED,
        status: DeliveryStatus.SENT,
      }),
    ).rejects.toBeInstanceOf(InvalidDeliveryStateError);
    await transitionDelivery(prisma, {
      deliveryId: delivery.id,
      expectedStatus: DeliveryStatus.QUEUED,
      status: DeliveryStatus.PROCESSING,
    });
    await expect(
      transitionDelivery(prisma, {
        deliveryId: delivery.id,
        expectedStatus: DeliveryStatus.QUEUED,
        status: DeliveryStatus.PROCESSING,
      }),
    ).rejects.toBeInstanceOf(DeliveryTransitionConflictError);
    await transitionDelivery(prisma, {
      deliveryId: delivery.id,
      expectedStatus: DeliveryStatus.PROCESSING,
      status: DeliveryStatus.SENT,
    });
    await expect(
      transitionDelivery(prisma, {
        deliveryId: delivery.id,
        expectedStatus: DeliveryStatus.SENT,
        status: DeliveryStatus.PROCESSING,
      }),
    ).rejects.toBeInstanceOf(InvalidDeliveryStateError);
    expect(await prisma.deliveryEvent.count({ where: { deliveryId: delivery.id } })).toBe(3);
  });

  it('allows exactly one concurrent compare-and-set transition', async () => {
    const notification = await notificationFor('concurrent');
    const delivery = await createDelivery(prisma, {
      notificationId: notification.id,
      channel: Channel.EMAIL,
      provider: 'mailpit',
    });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        transitionDelivery(prisma, {
          deliveryId: delivery.id,
          expectedStatus: DeliveryStatus.QUEUED,
          status: DeliveryStatus.PROCESSING,
        }),
      ),
    );

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(7);
    expect(await prisma.deliveryEvent.count({ where: { deliveryId: delivery.id } })).toBe(2);
  });

  it('rejects decreasing attempts and fields that do not apply to the target state', async () => {
    const notification = await notificationFor('metadata');
    const delivery = await createDelivery(prisma, {
      notificationId: notification.id,
      channel: Channel.EMAIL,
      provider: 'mailpit',
    });
    await transitionDelivery(prisma, {
      deliveryId: delivery.id,
      expectedStatus: DeliveryStatus.QUEUED,
      status: DeliveryStatus.PROCESSING,
      attempts: 2,
    });
    await expect(
      transitionDelivery(prisma, {
        deliveryId: delivery.id,
        expectedStatus: DeliveryStatus.PROCESSING,
        status: DeliveryStatus.RETRYING,
        attempts: 1,
      }),
    ).rejects.toBeInstanceOf(InvalidDeliveryStateError);
    await expect(
      transitionDelivery(prisma, {
        deliveryId: delivery.id,
        expectedStatus: DeliveryStatus.PROCESSING,
        status: DeliveryStatus.RETRYING,
        providerMessageId: 'wrong-state',
      }),
    ).rejects.toBeInstanceOf(InvalidDeliveryStateError);
    expect(await prisma.deliveryEvent.count({ where: { deliveryId: delivery.id } })).toBe(2);
  });

  it('rolls back the delivery update when the event insert fails', async () => {
    const notification = await notificationFor('rollback');
    const delivery = await createDelivery(prisma, {
      notificationId: notification.id,
      channel: Channel.EMAIL,
      provider: 'mailpit',
    });
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION reject_forced_delivery_event() RETURNS trigger AS $$
      BEGIN
        IF NEW.detail->>'forceFailure' = 'true' THEN
          RAISE EXCEPTION 'forced delivery event failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER reject_forced_delivery_event
      BEFORE INSERT ON delivery_events
      FOR EACH ROW EXECUTE FUNCTION reject_forced_delivery_event()
    `);

    try {
      await expect(
        transitionDelivery(prisma, {
          deliveryId: delivery.id,
          expectedStatus: DeliveryStatus.QUEUED,
          status: DeliveryStatus.PROCESSING,
          detail: { forceFailure: true },
        }),
      ).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER reject_forced_delivery_event ON delivery_events',
      );
      await prisma.$executeRawUnsafe('DROP FUNCTION reject_forced_delivery_event()');
    }

    await expect(
      prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id } }),
    ).resolves.toMatchObject({
      status: DeliveryStatus.QUEUED,
    });
    expect(await prisma.deliveryEvent.count({ where: { deliveryId: delivery.id } })).toBe(1);
  });

  it('retains current work and fixture configuration while pruning old terminal data', async () => {
    const cutoff = new Date('2026-07-07T12:00:00.000Z');
    const old = new Date(cutoff.getTime() - 1);
    const user = await prisma.user.create({
      data: { id: 'retention-user', email: 'retention@example.test' },
    });
    const template = await prisma.template.create({
      data: {
        event: 'retention.event',
        channel: Channel.EMAIL,
        body: 'Fixture configuration must survive retention.',
      },
    });
    const create = (
      id: string,
      createdAt: Date,
      status: NotificationStatus,
      deliveryStatus?: DeliveryStatus,
    ) =>
      prisma.notification.create({
        data: {
          id,
          userId: user.id,
          event: 'retention.event',
          payload: {},
          createdAt,
          status,
          ...(deliveryStatus === undefined
            ? {}
            : {
                deliveries: {
                  create: {
                    channel: Channel.EMAIL,
                    provider: 'mailpit',
                    status: deliveryStatus,
                  },
                },
              }),
        },
      });

    const expired = await create(
      '70000000-0000-4000-8000-000000000001',
      old,
      NotificationStatus.ROUTED,
      DeliveryStatus.SENT,
    );
    const active = await create(
      '70000000-0000-4000-8000-000000000002',
      old,
      NotificationStatus.ROUTED,
      DeliveryStatus.RETRYING,
    );
    const boundary = await create(
      '70000000-0000-4000-8000-000000000003',
      cutoff,
      NotificationStatus.ROUTED,
      DeliveryStatus.SENT,
    );
    const accepted = await create(
      '70000000-0000-4000-8000-000000000004',
      old,
      NotificationStatus.ACCEPTED,
    );

    const result = await createRetentionStore(prisma).prune(cutoff);

    expect(result.notifications).toBe(1);
    expect(await prisma.notification.findUnique({ where: { id: expired.id } })).toBeNull();
    for (const notification of [active, boundary, accepted]) {
      await expect(
        prisma.notification.findUnique({ where: { id: notification.id } }),
      ).resolves.not.toBeNull();
    }
    await expect(prisma.user.findUnique({ where: { id: user.id } })).resolves.not.toBeNull();
    await expect(
      prisma.template.findUnique({ where: { id: template.id } }),
    ).resolves.not.toBeNull();
  });
});
