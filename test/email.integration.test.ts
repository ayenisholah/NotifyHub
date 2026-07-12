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
  createEmailDeliveryHandler,
  createEmailWorker,
  createMailpitEmailProvider,
  EmailDeliveryError,
  EmailProviderMismatchError,
  EmailTemplateNotFoundError,
  type EmailProvider,
} from '../packages/workers/src/index.js';

const executeFile = promisify(execFile);
const prismaExecutable =
  process.platform === 'win32' ? 'node_modules/.bin/prisma.cmd' : 'node_modules/.bin/prisma';
let postgres: StartedPostgreSqlContainer;
let redis: StartedTestContainer;
let mailpit: StartedTestContainer;
let prisma: PrismaClient;

beforeAll(async () => {
  [postgres, redis, mailpit] = await Promise.all([
    new PostgreSqlContainer('postgres:18').start(),
    new GenericContainer('redis:8-alpine').withExposedPorts(6379).start(),
    new GenericContainer('axllent/mailpit:v1.27').withExposedPorts(1025, 8025).start(),
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
  await Promise.all([postgres?.stop(), redis?.stop(), mailpit?.stop()]);
});

async function fixture(label: string, provider = 'mailpit') {
  const user = await prisma.user.create({
    data: { id: `email-${label}`, email: `${label}@example.test` },
  });
  const notification = await prisma.notification.create({
    data: { userId: user.id, event: 'comment.created', payload: { text: '<hello>' } },
  });
  await prisma.template.create({
    data: {
      event: notification.event,
      channel: Channel.EMAIL,
      subject: 'For {{user.email}}',
      body: '{{payload.text}}',
      bodyHtml: '<p>{{payload.text}}</p>',
    },
  });
  return createDelivery(prisma, {
    notificationId: notification.id,
    channel: Channel.EMAIL,
    provider,
  });
}

function mockProvider(
  send = vi.fn(async () => ({ providerMessageId: 'mailpit-id' })),
): EmailProvider {
  return { name: 'mailpit', send };
}

describe.sequential('restart-safe email delivery handler', () => {
  it('records the complete lifecycle, renders the message, and replays without resending', async () => {
    const delivery = await fixture('complete');
    const provider = mockProvider();
    const handler = createEmailDeliveryHandler(prisma, provider);

    await expect(handler(delivery.id)).resolves.toEqual({ providerMessageId: 'mailpit-id' });
    await expect(handler(delivery.id)).resolves.toEqual({ providerMessageId: 'mailpit-id' });

    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(provider.send).toHaveBeenCalledWith({
      to: 'complete@example.test',
      subject: 'For complete@example.test',
      text: '<hello>',
      html: '<p>&lt;hello&gt;</p>',
      idempotencyKey: delivery.id,
    });
    await expect(
      prisma.delivery.findUniqueOrThrow({
        where: { id: delivery.id },
        include: { events: { orderBy: { id: 'asc' } } },
      }),
    ).resolves.toMatchObject({
      status: DeliveryStatus.SENT,
      attempts: 1,
      providerMessageId: 'mailpit-id',
      events: [
        { status: DeliveryStatus.QUEUED },
        { status: DeliveryStatus.PROCESSING },
        { status: DeliveryStatus.SENT },
      ],
    });
  });

  it('recovers processing rows without incrementing attempts and serializes concurrency', async () => {
    const delivery = await fixture('processing');
    await prisma.delivery.update({
      where: { id: delivery.id },
      data: { status: DeliveryStatus.PROCESSING, attempts: 3 },
    });
    const provider = mockProvider();
    const handler = createEmailDeliveryHandler(prisma, provider);
    const results = await Promise.all(Array.from({ length: 6 }, () => handler(delivery.id)));
    expect(results).toEqual(Array.from({ length: 6 }, () => ({ providerMessageId: 'mailpit-id' })));
    expect(provider.send).toHaveBeenCalledTimes(1);
    await expect(
      prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id } }),
    ).resolves.toMatchObject({
      status: DeliveryStatus.SENT,
      attempts: 3,
    });
  });

  it('leaves provider failures recoverable in processing', async () => {
    const delivery = await fixture('failure');
    const handler = createEmailDeliveryHandler(
      prisma,
      mockProvider(
        vi.fn(async () => {
          throw new Error('smtp unavailable');
        }),
      ),
    );
    await expect(handler(delivery.id)).rejects.toThrow('smtp unavailable');
    await expect(
      prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id } }),
    ).resolves.toMatchObject({
      status: DeliveryStatus.PROCESSING,
      attempts: 1,
    });
  });

  it('rejects provider mismatch, missing templates, and terminal states without mutation', async () => {
    const mismatch = await fixture('mismatch', 'resend');
    await expect(
      createEmailDeliveryHandler(prisma, mockProvider())(mismatch.id),
    ).rejects.toBeInstanceOf(EmailProviderMismatchError);
    const missing = await fixture('missing');
    await prisma.template.deleteMany();
    await expect(
      createEmailDeliveryHandler(prisma, mockProvider())(missing.id),
    ).rejects.toBeInstanceOf(EmailTemplateNotFoundError);
    await expect(
      prisma.delivery.findUniqueOrThrow({ where: { id: missing.id } }),
    ).resolves.toMatchObject({
      status: DeliveryStatus.QUEUED,
      attempts: 0,
    });
    await prisma.delivery.update({
      where: { id: missing.id },
      data: { status: DeliveryStatus.FAILED },
    });
    await expect(
      createEmailDeliveryHandler(prisma, mockProvider())(missing.id),
    ).rejects.toBeInstanceOf(EmailDeliveryError);
  });
});

describe.sequential('Mailpit BullMQ email worker', () => {
  it('delivers a real queued job through SMTP and persists Mailpit message identity', async () => {
    const delivery = await fixture('worker');
    const redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
    const provider = createMailpitEmailProvider({
      provider: 'mailpit',
      from: 'notifyhub@example.test',
      host: mailpit.getHost(),
      port: mailpit.getMappedPort(1025),
    });
    const worker = createEmailWorker(redisUrl, createEmailDeliveryHandler(prisma, provider));
    const producer = createChannelQueueProducer(redisUrl);
    try {
      await producer.enqueue(Channel.EMAIL, delivery.id);
      const deadline = Date.now() + 10_000;
      let persisted = await prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id } });
      while (persisted.status !== DeliveryStatus.SENT && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        persisted = await prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id } });
      }
      expect(persisted).toMatchObject({ status: DeliveryStatus.SENT, attempts: 1 });
      const response = await fetch(
        `http://${mailpit.getHost()}:${mailpit.getMappedPort(8025)}/api/v1/messages`,
      );
      const mailbox = (await response.json()) as {
        messages: Array<{ ID: string; To: Array<{ Address: string }>; Subject: string }>;
      };
      expect(mailbox.messages[0]).toMatchObject({
        To: [{ Address: 'worker@example.test' }],
        Subject: 'For worker@example.test',
      });
      expect(persisted.providerMessageId).toBeTruthy();
    } finally {
      await worker.close();
      await producer.close();
    }
  });
});
