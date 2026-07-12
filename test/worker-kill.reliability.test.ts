import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  Channel,
  createChannelQueueProducer,
  createDlqProducer,
  createPrismaClient,
  createRouteQueueProducer,
  DeliveryStatus,
  NotificationStatus,
  type PrismaClient,
} from '../packages/core/src/index.js';
import { reconcilePersistedWork } from '../packages/workers/src/index.js';

let postgres: Awaited<ReturnType<PostgreSqlContainer['start']>>;
let redis: Awaited<ReturnType<GenericContainer['start']>>;
let mailpit: Awaited<ReturnType<GenericContainer['start']>>;
let prisma: PrismaClient;
let databaseUrl: string;
let redisUrl: string;

beforeAll(async () => {
  [postgres, redis, mailpit] = await Promise.all([
    new PostgreSqlContainer('postgres:18').start(),
    new GenericContainer('redis:8-alpine').withExposedPorts(6379).start(),
    new GenericContainer('axllent/mailpit:v1.27').withExposedPorts(1025, 8025).start(),
  ]);
  databaseUrl = postgres.getConnectionUri();
  redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
  const { execFile } = await import('node:child_process');
  const prismaExecutable =
    process.platform === 'win32' ? 'node_modules/.bin/prisma.cmd' : 'node_modules/.bin/prisma';
  await new Promise<void>((resolve, reject) =>
    execFile(
      prismaExecutable,
      ['migrate', 'deploy'],
      { env: { ...process.env, DATABASE_URL: databaseUrl } },
      (error) => (error === null ? resolve() : reject(error)),
    ),
  );
  prisma = createPrismaClient(databaseUrl);
  await prisma.$connect();
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await Promise.all([postgres?.stop(), redis?.stop(), mailpit?.stop()]);
});

function startWorker(
  hold: boolean,
  concurrency: number,
): Promise<{ child: ChildProcess; sent: Promise<string> }> {
  const child = fork(path.resolve('test/fixtures/email-worker-child.mjs'), [], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      MAILPIT_HOST: mailpit.getHost(),
      MAILPIT_PORT: String(mailpit.getMappedPort(1025)),
      HOLD_AFTER_SEND: hold ? '1' : '0',
      WORKER_CONCURRENCY: String(concurrency),
    },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  let resolveSent!: (id: string) => void;
  const sent = new Promise<string>((resolve) => {
    resolveSent = resolve;
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.on('message', (message: unknown) => {
      if (typeof message !== 'object' || message === null || !('type' in message)) return;
      if (message.type === 'sent' && 'deliveryId' in message)
        resolveSent(String(message.deliveryId));
      if (message.type === 'ready') resolve({ child, sent });
    });
  });
}

async function waitForTerminal(expected: number): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const count = await prisma.delivery.count({
      where: { status: { in: [DeliveryStatus.SENT, DeliveryStatus.FAILED, DeliveryStatus.DLQ] } },
    });
    if (count === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for terminal deliveries');
}

async function stopChild(child: ChildProcess | undefined, signal: NodeJS.Signals): Promise<void> {
  if (child === undefined || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill(signal);
  await exited;
}

describe.sequential('worker kill reliability gate', () => {
  it('recovers 500 in-flight emails with no loss and only the documented SMTP duplicate', async () => {
    const validCount = 500;
    const users = Array.from({ length: validCount }, (_, index) => ({
      id: `kill-user-${index}`,
      email: `kill-${index}@example.test`,
    }));
    await prisma.user.createMany({
      data: [...users, { id: 'kill-poison', email: 'poison@example.test' }],
    });
    await prisma.template.create({
      data: {
        event: 'kill.valid',
        channel: Channel.EMAIL,
        subject: 'Reliability {{user.id}}',
        body: '{{payload.index}}',
      },
    });
    const notifications = users.map((user, index) => ({
      id: randomUUID(),
      userId: user.id,
      event: 'kill.valid',
      payload: { index },
      status: NotificationStatus.ROUTED,
    }));
    const poisonNotification = {
      id: randomUUID(),
      userId: 'kill-poison',
      event: 'kill.poison',
      payload: {},
      status: NotificationStatus.ROUTED,
    };
    await prisma.notification.createMany({ data: [...notifications, poisonNotification] });
    const deliveries = notifications.map((notification) => ({
      id: randomUUID(),
      notificationId: notification.id,
      channel: Channel.EMAIL,
      provider: 'mailpit',
    }));
    const poisonDelivery = {
      id: randomUUID(),
      notificationId: poisonNotification.id,
      channel: Channel.EMAIL,
      provider: 'mailpit',
    };
    await prisma.delivery.createMany({ data: [...deliveries, poisonDelivery] });
    await prisma.deliveryEvent.createMany({
      data: [...deliveries, poisonDelivery].map((delivery) => ({
        deliveryId: delivery.id,
        status: DeliveryStatus.QUEUED,
      })),
    });

    const channelJobs = createChannelQueueProducer(redisUrl);
    const routeJobs = createRouteQueueProducer(redisUrl);
    const dlq = createDlqProducer(redisUrl);
    let first: ChildProcess | undefined;
    let replacement: ChildProcess | undefined;
    try {
      const started = await startWorker(true, 1);
      first = started.child;
      await Promise.all(
        [...deliveries, poisonDelivery].map((delivery) =>
          channelJobs.enqueue(Channel.EMAIL, delivery.id),
        ),
      );
      const killedDeliveryId = await started.sent;
      first.kill('SIGKILL');
      await new Promise<void>((resolve) => first!.once('exit', () => resolve()));

      await reconcilePersistedWork(
        prisma,
        { routeJobs, channelJobs, dlq },
        new Date(Date.now() + 1),
      );
      replacement = (await startWorker(false, 25)).child;
      await waitForTerminal(validCount + 1);

      expect(await prisma.delivery.count({ where: { status: DeliveryStatus.SENT } })).toBe(
        validCount,
      );
      expect(await prisma.delivery.count({ where: { status: DeliveryStatus.DLQ } })).toBe(1);
      expect(
        await prisma.delivery.count({
          where: {
            status: {
              in: [
                DeliveryStatus.QUEUED,
                DeliveryStatus.SCHEDULED,
                DeliveryStatus.PROCESSING,
                DeliveryStatus.RETRYING,
              ],
            },
          },
        }),
      ).toBe(0);
      const killed = await prisma.delivery.findUniqueOrThrow({
        where: { id: killedDeliveryId },
        include: { notification: { include: { user: true } } },
      });
      expect(killed.status).toBe(DeliveryStatus.SENT);
      expect(killed.attempts).toBeGreaterThanOrEqual(1);

      const mailbox = await fetch(
        `http://${mailpit.getHost()}:${mailpit.getMappedPort(8025)}/api/v1/messages?limit=1000`,
      );
      const body = (await mailbox.json()) as {
        messages: Array<{ To: Array<{ Address: string }> }>;
      };
      const counts = new Map<string, number>();
      for (const message of body.messages)
        for (const recipient of message.To)
          counts.set(recipient.Address, (counts.get(recipient.Address) ?? 0) + 1);
      expect(counts.get(killed.notification.user.email)).toBe(2);
      expect([...counts.values()].filter((count) => count !== 1)).toEqual([2]);
      expect(body.messages).toHaveLength(validCount + 1);

      const firstSweep = await reconcilePersistedWork(
        prisma,
        { routeJobs, channelJobs, dlq },
        new Date(Date.now() + 1),
      );
      const eventCount = await prisma.deliveryEvent.count();
      const secondSweep = await reconcilePersistedWork(
        prisma,
        { routeJobs, channelJobs, dlq },
        new Date(Date.now() + 1),
      );
      expect(firstSweep).toEqual({ notifications: 0, deliveries: 0, deadLetters: 1 });
      expect(secondSweep).toEqual(firstSweep);
      expect(await prisma.deliveryEvent.count()).toBe(eventCount);
    } finally {
      await stopChild(first, 'SIGKILL');
      await stopChild(replacement, 'SIGTERM');
      await Promise.all([channelJobs.close(), routeJobs.close(), dlq.close()]);
    }
  }, 180_000);
});
