import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createPersistentDashboardHandlers,
  DashboardNotificationNotFoundError,
  decodeDashboardDlqCursor,
  decodeDashboardNotificationCursor,
} from '../packages/api/src/index.js';
import {
  Channel,
  createPrismaClient,
  DeliveryStatus,
  NotificationStatus,
  type Prisma,
  type PrismaClient,
} from '../packages/core/src/index.js';

const executeFile = promisify(execFile);
const prismaExecutable =
  process.platform === 'win32' ? 'node_modules/.bin/prisma.cmd' : 'node_modules/.bin/prisma';
const demoUserId = 'synthetic-dashboard-demo';
const otherUserId = 'private-real-user';
const now = new Date('2026-07-13T12:00:00.000Z');

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
  await prisma.user.createMany({
    data: [
      {
        id: demoUserId,
        email: 'synthetic-demo-recipient@example.test',
        phone: '+15550000001',
      },
      {
        id: otherUserId,
        email: 'private-real-recipient@example.test',
        phone: '+15550000002',
      },
    ],
  });
});

afterAll(async () => {
  await prisma?.$disconnect();
  await container?.stop();
});

interface SeedEvent {
  status: DeliveryStatus;
  createdAt: Date;
  detail?: Prisma.InputJsonValue;
}

interface SeedDelivery {
  id: string;
  channel: Channel;
  status: DeliveryStatus;
  attempts?: number;
  createdAt: Date;
  updatedAt: Date;
  events?: SeedEvent[];
  lastError?: string;
}

async function seedNotification(input: {
  id: string;
  userId?: string;
  event?: string;
  status?: NotificationStatus;
  noOpReason?: string;
  createdAt: Date;
  deliveries?: SeedDelivery[];
}) {
  return prisma.notification.create({
    data: {
      id: input.id,
      userId: input.userId ?? demoUserId,
      event: input.event ?? 'dashboard.test',
      payload: {
        recipientEmail: 'must-never-leak@example.test',
        phone: '+15559999999',
        nested: { private: 'secret-payload-value' },
      },
      status: input.status ?? NotificationStatus.ROUTED,
      ...(input.noOpReason === undefined ? {} : { noOpReason: input.noOpReason }),
      createdAt: input.createdAt,
      ...(input.deliveries === undefined
        ? {}
        : {
            deliveries: {
              create: input.deliveries.map((delivery) => ({
                id: delivery.id,
                channel: delivery.channel,
                provider: 'private-provider-name',
                providerMessageId: 'private-provider-message-id',
                status: delivery.status,
                attempts: delivery.attempts ?? 0,
                lastError: delivery.lastError ?? 'raw private provider error',
                createdAt: delivery.createdAt,
                updatedAt: delivery.updatedAt,
                ...(delivery.events === undefined
                  ? {}
                  : {
                      events: {
                        create: delivery.events.map((event) => ({
                          status: event.status,
                          createdAt: event.createdAt,
                          ...(event.detail === undefined ? {} : { detail: event.detail }),
                        })),
                      },
                    }),
              })),
            },
          }),
    },
  });
}

function uuid(group: number, value: number): string {
  return `${String(group).padStart(8, '0')}-0000-4000-8000-${String(value).padStart(12, '0')}`;
}

describe.sequential('persistent public dashboard handlers', () => {
  it('counts exact current states and distinct SENT transitions inside the injected UTC day', async () => {
    const statuses = [
      DeliveryStatus.QUEUED,
      DeliveryStatus.SCHEDULED,
      DeliveryStatus.PROCESSING,
      DeliveryStatus.RETRYING,
      DeliveryStatus.FAILED,
      DeliveryStatus.DLQ,
    ] as const;
    for (let index = 0; index < statuses.length; index += 1) {
      const status = statuses[index]!;
      await seedNotification({
        id: uuid(1, index + 1),
        createdAt: new Date(`2026-07-13T01:00:0${index}.000Z`),
        deliveries: [
          {
            id: uuid(2, index + 1),
            channel: Channel.EMAIL,
            status,
            createdAt: new Date(`2026-07-13T01:00:0${index}.000Z`),
            updatedAt: new Date(`2026-07-13T01:00:1${index}.000Z`),
            events: [{ status, createdAt: new Date(`2026-07-13T01:00:0${index}.000Z`) }],
          },
        ],
      });
    }

    const sentTimes = [
      new Date('2026-07-13T00:00:00.000Z'),
      new Date('2026-07-12T23:59:59.999Z'),
      new Date('2026-07-13T12:00:00.001Z'),
    ];
    for (let index = 0; index < sentTimes.length; index += 1) {
      const sentAt = sentTimes[index]!;
      await seedNotification({
        id: uuid(3, index + 1),
        createdAt: sentAt,
        deliveries: [
          {
            id: uuid(4, index + 1),
            channel: Channel.EMAIL,
            status: DeliveryStatus.SENT,
            createdAt: sentAt,
            updatedAt: sentAt,
            events: [{ status: DeliveryStatus.SENT, createdAt: sentAt }],
          },
        ],
      });
    }

    await seedNotification({
      id: uuid(5, 1),
      createdAt: new Date('2026-07-13T05:00:00.000Z'),
      deliveries: [
        {
          id: uuid(6, 1),
          channel: Channel.EMAIL,
          status: DeliveryStatus.SENT,
          createdAt: new Date('2026-07-13T05:00:00.000Z'),
          updatedAt: new Date('2026-07-13T05:00:02.000Z'),
          events: [
            { status: DeliveryStatus.SENT, createdAt: new Date('2026-07-13T05:00:01.000Z') },
            { status: DeliveryStatus.SENT, createdAt: new Date('2026-07-13T05:00:02.000Z') },
          ],
        },
      ],
    });
    await seedNotification({
      id: uuid(7, 1),
      userId: otherUserId,
      createdAt: new Date('2026-07-13T06:00:00.000Z'),
      deliveries: [
        {
          id: uuid(8, 1),
          channel: Channel.EMAIL,
          status: DeliveryStatus.DLQ,
          createdAt: new Date('2026-07-13T06:00:00.000Z'),
          updatedAt: new Date('2026-07-13T06:00:01.000Z'),
          events: [
            { status: DeliveryStatus.SENT, createdAt: new Date('2026-07-13T06:00:01.000Z') },
          ],
        },
      ],
    });

    const handlers = createPersistentDashboardHandlers(prisma, ` ${demoUserId} `, {
      now: () => now,
    });
    await expect(handlers.summary()).resolves.toEqual({
      sentToday: 2,
      inFlight: 4,
      failed: 1,
      dlq: 1,
    });
  });

  it('paginates tied notification and DLQ timestamps stably while excluding other users', async () => {
    const tied = new Date('2026-07-13T10:00:00.000Z');
    for (let index = 1; index <= 3; index += 1) {
      await seedNotification({
        id: uuid(10, index),
        event: `demo.event.${index}`,
        createdAt: tied,
        deliveries: [
          {
            id: uuid(11, index),
            channel: Channel.EMAIL,
            status: DeliveryStatus.DLQ,
            attempts: index,
            createdAt: new Date('2026-07-13T09:00:00.000Z'),
            updatedAt: tied,
            events: [
              {
                status: DeliveryStatus.DLQ,
                createdAt: tied,
                detail: {
                  reason: 'delivery_dead_lettered',
                  errorKind: 'SmsRecipientMissingError',
                  error: 'raw secret error',
                },
              },
            ],
          },
        ],
      });
    }
    await seedNotification({
      id: uuid(10, 99),
      userId: otherUserId,
      event: 'private.event',
      createdAt: tied,
      deliveries: [
        {
          id: uuid(11, 99),
          channel: Channel.SMS,
          status: DeliveryStatus.DLQ,
          createdAt: tied,
          updatedAt: tied,
        },
      ],
    });

    const handlers = createPersistentDashboardHandlers(prisma, demoUserId, { now: () => now });
    const firstNotifications = await handlers.listNotifications({ limit: 2 });
    expect(firstNotifications.items.map(({ notificationId }) => notificationId)).toEqual([
      uuid(10, 3),
      uuid(10, 2),
    ]);
    expect(decodeDashboardNotificationCursor(firstNotifications.nextCursor!).id).toBe(uuid(10, 2));
    const secondNotifications = await handlers.listNotifications({
      limit: 2,
      cursor: firstNotifications.nextCursor!,
    });
    expect(secondNotifications.items.map(({ notificationId }) => notificationId)).toEqual([
      uuid(10, 1),
    ]);
    expect(secondNotifications.nextCursor).toBeNull();

    const firstDlq = await handlers.listDlq({ limit: 2 });
    expect(firstDlq.items.map(({ deliveryId }) => deliveryId)).toEqual([uuid(11, 3), uuid(11, 2)]);
    expect(firstDlq.items[0]).toMatchObject({
      reason: 'delivery_dead_lettered',
      errorClassification: 'SmsRecipientMissingError',
    });
    expect(decodeDashboardDlqCursor(firstDlq.nextCursor!).id).toBe(uuid(11, 2));
    const secondDlq = await handlers.listDlq({ limit: 2, cursor: firstDlq.nextCursor! });
    expect(secondDlq.items.map(({ deliveryId }) => deliveryId)).toEqual([uuid(11, 1)]);
    expect(secondDlq.nextCursor).toBeNull();
  });

  it('returns channel-grouped chronological timelines and recursively excludes sensitive data', async () => {
    const notificationId = uuid(20, 1);
    const emailDeliveryId = uuid(21, 1);
    const smsDeliveryId = uuid(21, 2);
    const base = new Date('2026-07-13T08:00:00.000Z');
    await seedNotification({
      id: notificationId,
      event: 'account.security-alert',
      createdAt: base,
      deliveries: [
        {
          id: smsDeliveryId,
          channel: Channel.SMS,
          status: DeliveryStatus.FAILED,
          attempts: 2,
          createdAt: base,
          updatedAt: new Date('2026-07-13T08:00:04.000Z'),
        },
        {
          id: emailDeliveryId,
          channel: Channel.EMAIL,
          status: DeliveryStatus.FAILED,
          attempts: 2,
          createdAt: base,
          updatedAt: new Date('2026-07-13T08:00:04.000Z'),
        },
      ],
    });

    await prisma.deliveryEvent.create({
      data: {
        deliveryId: emailDeliveryId,
        status: DeliveryStatus.RETRYING,
        createdAt: new Date('2026-07-13T08:00:03.000Z'),
        detail: {
          reason: 'delivery_retry_scheduled',
          errorKind: 'ProviderDeliveryError',
          rawError: 'SMTP auth failed for secret-token',
          provider: 'private-provider-name',
          recipient: 'must-never-leak@example.test',
          nested: { payload: 'secret-event-detail' },
        },
      },
    });
    await prisma.deliveryEvent.createMany({
      data: [
        {
          deliveryId: emailDeliveryId,
          status: DeliveryStatus.QUEUED,
          createdAt: new Date('2026-07-13T08:00:01.000Z'),
          detail: { reason: 'quiet_hours', timezone: 'Private/Timezone' },
        },
        {
          deliveryId: emailDeliveryId,
          status: DeliveryStatus.PROCESSING,
          createdAt: new Date('2026-07-13T08:00:03.000Z'),
          detail: { reason: 'untrusted_reason', errorKind: 'DatabaseCredentialError' },
        },
      ],
    });

    const handlers = createPersistentDashboardHandlers(prisma, demoUserId, { now: () => now });
    const detail = await handlers.getNotification(notificationId);
    expect(detail.deliveries.map(({ channel }) => channel)).toEqual([Channel.EMAIL, Channel.SMS]);
    expect(detail.deliveries[0]!.timeline).toEqual([
      {
        status: DeliveryStatus.QUEUED,
        createdAt: '2026-07-13T08:00:01.000Z',
        reason: 'quiet_hours',
        errorClassification: null,
      },
      {
        status: DeliveryStatus.RETRYING,
        createdAt: '2026-07-13T08:00:03.000Z',
        reason: 'delivery_retry_scheduled',
        errorClassification: 'ProviderDeliveryError',
      },
      {
        status: DeliveryStatus.PROCESSING,
        createdAt: '2026-07-13T08:00:03.000Z',
        reason: null,
        errorClassification: null,
      },
    ]);

    const list = await handlers.listNotifications({ limit: 20 });
    const serialized = JSON.stringify({ detail, list });
    for (const secret of [
      demoUserId,
      otherUserId,
      'must-never-leak@example.test',
      '+15559999999',
      'secret-payload-value',
      'private-provider-name',
      'private-provider-message-id',
      'raw private provider error',
      'SMTP auth failed for secret-token',
      'Private/Timezone',
      'secret-event-detail',
      'DatabaseCredentialError',
      'untrusted_reason',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    const forbiddenKeys = new Set([
      'userId',
      'email',
      'phone',
      'payload',
      'provider',
      'providerMessageId',
      'lastError',
      'detail',
      'rawError',
      'recipient',
    ]);
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (typeof value !== 'object' || value === null) return;
      for (const [key, child] of Object.entries(value)) {
        expect(forbiddenKeys.has(key)).toBe(false);
        visit(child);
      }
    };
    visit(detail);
    visit(list);
  });

  it('makes a cross-user detail indistinguishable from a missing notification', async () => {
    const privateId = uuid(30, 1);
    const missingId = uuid(30, 2);
    await seedNotification({
      id: privateId,
      userId: otherUserId,
      event: 'private.event',
      createdAt: now,
    });
    const handlers = createPersistentDashboardHandlers(prisma, demoUserId, { now: () => now });
    for (const id of [privateId, missingId]) {
      await expect(handlers.getNotification(id)).rejects.toMatchObject({
        name: new DashboardNotificationNotFoundError().name,
        message: new DashboardNotificationNotFoundError().message,
      });
    }
  });
});
