import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
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
  createMockSmsProvider,
  createSmsDeliveryHandler,
  createSmsWorker,
  MockSmsProviderError,
  ProviderDeliveryError,
  recordDeliveryFailure,
  SmsDeliveryError,
  SmsProviderMismatchError,
  SmsRecipientMissingError,
  SmsTemplateNotFoundError,
  type SmsProvider,
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

async function fixture(label: string, options: { phone?: string | null; provider?: string } = {}) {
  const user = await prisma.user.create({
    data: {
      id: `sms-${label}`,
      email: `${label}@example.test`,
      phone: options.phone === undefined ? '+2348000000000' : options.phone,
    },
  });
  const notification = await prisma.notification.create({
    data: { userId: user.id, event: `comment.${label}`, payload: { text: '<hello>' } },
  });
  await prisma.template.create({
    data: {
      event: notification.event,
      channel: Channel.SMS,
      subject: 'Ignored subject',
      body: '{{payload.text}} for {{user.phone}}',
      bodyHtml: '<b>ignored</b>',
    },
  });
  return createDelivery(prisma, {
    notificationId: notification.id,
    channel: Channel.SMS,
    provider: options.provider ?? 'mock',
  });
}

function provider(send = vi.fn(async () => ({ providerMessageId: 'mock-id' }))): SmsProvider {
  return { name: 'mock', send };
}

describe.sequential('restart-safe SMS delivery handler', () => {
  it('records a complete lifecycle and replays without sending again', async () => {
    const delivery = await fixture('complete');
    const mock = provider();
    const handler = createSmsDeliveryHandler(prisma, mock);
    await expect(handler(delivery.id)).resolves.toEqual({ providerMessageId: 'mock-id' });
    await expect(handler(delivery.id)).resolves.toEqual({ providerMessageId: 'mock-id' });
    expect(mock.send).toHaveBeenCalledTimes(1);
    expect(mock.send).toHaveBeenCalledWith({
      to: '+2348000000000',
      text: '<hello> for +2348000000000',
      idempotencyKey: delivery.id,
      attempt: 1,
    });
    await expect(
      prisma.delivery.findUniqueOrThrow({
        where: { id: delivery.id },
        include: { events: { orderBy: { id: 'asc' } } },
      }),
    ).resolves.toMatchObject({
      status: DeliveryStatus.SENT,
      attempts: 1,
      providerMessageId: 'mock-id',
      events: [
        { status: DeliveryStatus.QUEUED },
        { status: DeliveryStatus.PROCESSING },
        { status: DeliveryStatus.SENT },
      ],
    });
  });

  it('records retrying attempts and fails the fifth attempt with sanitized errors', async () => {
    const delivery = await fixture('retry-policy');
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await prisma.delivery.update({
        where: { id: delivery.id },
        data: { status: DeliveryStatus.PROCESSING, attempts: attempt },
      });
      const outcome = await recordDeliveryFailure(
        prisma,
        delivery.id,
        new ProviderDeliveryError('mock', true),
      );
      expect(outcome).toBe(attempt < 5 ? 'retry' : 'failed');
    }
    const persisted = await prisma.delivery.findUniqueOrThrow({
      where: { id: delivery.id },
      include: { events: { orderBy: { id: 'asc' } } },
    });
    expect(persisted).toMatchObject({
      status: DeliveryStatus.FAILED,
      attempts: 5,
      lastError: 'mock delivery failed',
    });
    expect(persisted.events.map(({ status }) => status)).toEqual([
      DeliveryStatus.QUEUED,
      DeliveryStatus.RETRYING,
      DeliveryStatus.RETRYING,
      DeliveryStatus.RETRYING,
      DeliveryStatus.RETRYING,
      DeliveryStatus.FAILED,
    ]);
  });

  it('claims permanent preflight failures once and keeps terminal rows stable', async () => {
    const delivery = await fixture('permanent', { phone: null });
    const handler = createSmsDeliveryHandler(prisma, provider());
    let error: unknown;
    try {
      await handler(delivery.id);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SmsRecipientMissingError);
    await expect(recordDeliveryFailure(prisma, delivery.id, error)).resolves.toBe('failed');
    await expect(recordDeliveryFailure(prisma, delivery.id, error)).resolves.toBe('failed');
    await expect(
      prisma.delivery.findUniqueOrThrow({
        where: { id: delivery.id },
        include: { events: { orderBy: { id: 'asc' } } },
      }),
    ).resolves.toMatchObject({
      status: DeliveryStatus.FAILED,
      attempts: 1,
      lastError: 'SMS recipient phone is missing for user: sms-permanent',
      events: [
        { status: DeliveryStatus.QUEUED },
        { status: DeliveryStatus.PROCESSING },
        { status: DeliveryStatus.FAILED },
      ],
    });
  });

  it('recovers processing attempts and serializes concurrency', async () => {
    const delivery = await fixture('processing');
    await prisma.delivery.update({
      where: { id: delivery.id },
      data: { status: DeliveryStatus.PROCESSING, attempts: 3 },
    });
    const mock = provider();
    const handler = createSmsDeliveryHandler(prisma, mock);
    await Promise.all(Array.from({ length: 6 }, () => handler(delivery.id)));
    expect(mock.send).toHaveBeenCalledTimes(1);
    expect(mock.send).toHaveBeenCalledWith(expect.objectContaining({ attempt: 3 }));
    await expect(
      prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id } }),
    ).resolves.toMatchObject({
      status: DeliveryStatus.SENT,
      attempts: 3,
    });
  });

  it('leaves simulated failures recoverable in processing', async () => {
    const delivery = await fixture('failure');
    const handler = createSmsDeliveryHandler(
      prisma,
      createMockSmsProvider({ provider: 'mock', failureRate: 1 }),
    );
    await expect(handler(delivery.id)).rejects.toBeInstanceOf(MockSmsProviderError);
    await expect(
      prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id } }),
    ).resolves.toMatchObject({
      status: DeliveryStatus.PROCESSING,
      attempts: 1,
    });
  });

  it('rejects missing recipients, templates, mismatches, and terminal states without sending', async () => {
    const missingPhone = await fixture('phone', { phone: null });
    await expect(
      createSmsDeliveryHandler(prisma, provider())(missingPhone.id),
    ).rejects.toBeInstanceOf(SmsRecipientMissingError);
    const missingTemplate = await fixture('template');
    await prisma.template.delete({
      where: {
        event_channel_locale: { event: 'comment.template', channel: Channel.SMS, locale: 'en' },
      },
    });
    await expect(
      createSmsDeliveryHandler(prisma, provider())(missingTemplate.id),
    ).rejects.toBeInstanceOf(SmsTemplateNotFoundError);
    const mismatch = await fixture('mismatch', { provider: 'other' });
    await expect(createSmsDeliveryHandler(prisma, provider())(mismatch.id)).rejects.toBeInstanceOf(
      SmsProviderMismatchError,
    );
    await prisma.delivery.update({
      where: { id: missingTemplate.id },
      data: { status: DeliveryStatus.DLQ },
    });
    await expect(
      createSmsDeliveryHandler(prisma, provider())(missingTemplate.id),
    ).rejects.toBeInstanceOf(SmsDeliveryError);
  });
});

describe.sequential('mock SMS BullMQ worker', () => {
  it('consumes a real job and records its deterministic provider ID and log event', async () => {
    const delivery = await fixture('worker');
    const logs = vi.fn();
    const mock = createMockSmsProvider({ provider: 'mock', failureRate: 0 }, { logger: logs });
    const redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
    const worker = createSmsWorker(redisUrl, createSmsDeliveryHandler(prisma, mock));
    const producer = createChannelQueueProducer(redisUrl);
    try {
      await producer.enqueue(Channel.SMS, delivery.id);
      const expectedId = `mock-sms-${delivery.id}-1`;
      const deadline = Date.now() + 10_000;
      let persisted = await prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id } });
      while (persisted.status !== DeliveryStatus.SENT && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        persisted = await prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id } });
      }
      expect(persisted).toMatchObject({
        status: DeliveryStatus.SENT,
        attempts: 1,
        providerMessageId: expectedId,
      });
      expect(logs).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'sent',
          deliveryId: delivery.id,
          providerMessageId: expectedId,
        }),
      );
    } finally {
      await worker.close();
      await producer.close();
    }
  });

  it('retries three transient failures and succeeds on execution four', async () => {
    const delivery = await fixture('transient');
    const attempts: number[] = [];
    const mock = createMockSmsProvider(
      { provider: 'mock', failureRate: 0 },
      {
        outcome: (_deliveryId, attempt) => {
          attempts.push(attempt);
          return attempt < 4;
        },
      },
    );
    const redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
    const worker = createSmsWorker(redisUrl, createSmsDeliveryHandler(prisma, mock));
    const producer = createChannelQueueProducer(redisUrl);
    try {
      await producer.enqueue(Channel.SMS, delivery.id);
      const deadline = Date.now() + 20_000;
      let persisted = await prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id } });
      while (persisted.status !== DeliveryStatus.SENT && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        persisted = await prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id } });
      }
      expect(attempts).toEqual([1, 2, 3, 4]);
      expect(persisted).toMatchObject({
        status: DeliveryStatus.SENT,
        attempts: 4,
        providerMessageId: `mock-sms-${delivery.id}-4`,
      });
      const events = await prisma.deliveryEvent.findMany({
        where: { deliveryId: delivery.id },
        orderBy: { id: 'asc' },
      });
      expect(events.map(({ status }) => status)).toEqual([
        DeliveryStatus.QUEUED,
        DeliveryStatus.PROCESSING,
        DeliveryStatus.RETRYING,
        DeliveryStatus.PROCESSING,
        DeliveryStatus.RETRYING,
        DeliveryStatus.PROCESSING,
        DeliveryStatus.RETRYING,
        DeliveryStatus.PROCESSING,
        DeliveryStatus.SENT,
      ]);
    } finally {
      await worker.close();
      await producer.close();
    }
  }, 30_000);
});
