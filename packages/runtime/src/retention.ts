import { setTimeout as delay } from 'node:timers/promises';

import { Queue } from 'bullmq';

import {
  CHANNEL_QUEUE_NAMES,
  createPrismaClient,
  createRedisConnection,
  DIGEST_QUEUE_NAME,
  DLQ_QUEUE_NAME,
  Prisma,
  ROUTE_QUEUE_NAME,
  type PrismaClient,
} from '@notifyhub/core';

const DAY_MS = 24 * 60 * 60 * 1_000;
const CLEAN_BATCH_SIZE = 1_000;
const ACTIVE_DRAIN_TIMEOUT_MS = 60_000;

export const RETENTION_QUEUE_NAMES = [
  ROUTE_QUEUE_NAME,
  ...Object.values(CHANNEL_QUEUE_NAMES),
  DIGEST_QUEUE_NAME,
  DLQ_QUEUE_NAME,
] as const;

export interface RetentionQueue {
  readonly name: string;
  isPaused(): Promise<boolean>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  getActiveCount(): Promise<number>;
  clean(grace: number, limit: number, type: 'completed' | 'failed'): Promise<readonly unknown[]>;
  getJobs(types: readonly ('waiting' | 'paused')[]): Promise<readonly RetentionJob[]>;
  close(): Promise<void>;
}

export interface RetentionJob {
  readonly timestamp: number;
  remove(): Promise<void>;
}

export interface RetentionStore {
  prune(cutoff: Date): Promise<{ notifications: number; digestBatches: number }>;
}

export interface RetentionResult {
  readonly cutoff: string;
  readonly notifications: number;
  readonly digestBatches: number;
  readonly queueJobs: number;
}

export function parseRetentionDays(value: string | undefined): number {
  const days = Number(value ?? '7');
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error('DEMO_DATA_RETENTION_DAYS must be an integer between 1 and 365');
  }
  return days;
}

export function createRetentionStore(prisma: PrismaClient): RetentionStore {
  return {
    async prune(cutoff) {
      const notifications = await prisma.$executeRaw(Prisma.sql`
        DELETE FROM "notifications" AS notification
        WHERE notification."created_at" < ${cutoff}
          AND notification."status" IN ('ROUTED'::"NotificationStatus", 'NO_OP'::"NotificationStatus")
          AND NOT EXISTS (
            SELECT 1
            FROM "deliveries" AS delivery
            WHERE delivery."notification_id" = notification."id"
              AND delivery."status" NOT IN ('SENT'::"DeliveryStatus", 'DLQ'::"DeliveryStatus")
          )
          AND NOT EXISTS (
            SELECT 1
            FROM "digest_items" AS item
            INNER JOIN "digest_batches" AS batch ON batch."id" = item."batch_id"
            WHERE item."notification_id" = notification."id"
              AND batch."status" = 'OPEN'::"DigestBatchStatus"
          )
      `);
      const digestBatches = await prisma.$executeRaw(Prisma.sql`
        DELETE FROM "digest_batches" AS batch
        WHERE batch."status" = 'FLUSHED'::"DigestBatchStatus"
          AND batch."window_ends_at" < ${cutoff}
          AND NOT EXISTS (
            SELECT 1 FROM "digest_items" AS item WHERE item."batch_id" = batch."id"
          )
      `);
      return { notifications, digestBatches };
    },
  };
}

async function waitForActiveJobs(
  queues: readonly RetentionQueue[],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const active = await Promise.all(queues.map(async (queue) => queue.getActiveCount()));
    if (active.every((count) => count === 0)) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${active.reduce((sum, count) => sum + count, 0)} active jobs`,
      );
    }
    await delay(250);
  }
}

async function cleanHistory(queue: RetentionQueue, graceMs: number): Promise<number> {
  let removed = 0;
  for (const type of ['completed', 'failed'] as const) {
    while (true) {
      const jobs = await queue.clean(graceMs, CLEAN_BATCH_SIZE, type);
      removed += jobs.length;
      if (jobs.length < CLEAN_BATCH_SIZE) break;
    }
  }
  return removed;
}

async function cleanTerminalDlq(queue: RetentionQueue, cutoffMs: number): Promise<number> {
  if (queue.name !== DLQ_QUEUE_NAME) return 0;
  const jobs = await queue.getJobs(['waiting', 'paused']);
  const expired = jobs.filter((job) => job.timestamp < cutoffMs);
  await Promise.all(expired.map(async (job) => job.remove()));
  return expired.length;
}

export async function runRetention(options: {
  readonly queues: readonly RetentionQueue[];
  readonly store: RetentionStore;
  readonly days: number;
  readonly now?: Date;
  readonly drainTimeoutMs?: number;
}): Promise<RetentionResult> {
  const now = options.now ?? new Date();
  const graceMs = options.days * DAY_MS;
  const cutoff = new Date(now.getTime() - graceMs);
  const pausedBefore = await Promise.all(
    options.queues.map(async (queue) => [queue, await queue.isPaused()] as const),
  );

  try {
    await Promise.all(
      pausedBefore.map(async ([queue, wasPaused]) => {
        if (!wasPaused) await queue.pause();
      }),
    );
    await waitForActiveJobs(options.queues, options.drainTimeoutMs ?? ACTIVE_DRAIN_TIMEOUT_MS);
    const queueCounts = await Promise.all(
      options.queues.map(
        async (queue) =>
          (await cleanHistory(queue, graceMs)) + (await cleanTerminalDlq(queue, cutoff.getTime())),
      ),
    );
    const database = await options.store.prune(cutoff);
    return {
      cutoff: cutoff.toISOString(),
      notifications: database.notifications,
      digestBatches: database.digestBatches,
      queueJobs: queueCounts.reduce((sum, count) => sum + count, 0),
    };
  } finally {
    await Promise.all(
      pausedBefore.map(async ([queue, wasPaused]) => {
        if (!wasPaused) await queue.resume();
      }),
    );
  }
}

export async function runProductionRetention(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (databaseUrl === undefined || redisUrl === undefined) {
    throw new Error('DATABASE_URL and REDIS_URL are required for retention');
  }
  const prisma = createPrismaClient(databaseUrl);
  const connection = createRedisConnection(redisUrl);
  const queues = RETENTION_QUEUE_NAMES.map(
    (name) => new Queue(name, { connection }) as Queue & RetentionQueue,
  );
  try {
    const result = await runRetention({
      queues,
      store: createRetentionStore(prisma),
      days: parseRetentionDays(process.env.DEMO_DATA_RETENTION_DAYS),
    });
    process.stdout.write(`${JSON.stringify({ event: 'retention_completed', ...result })}\n`);
  } finally {
    await Promise.all(queues.map(async (queue) => queue.close()));
    await prisma.$disconnect();
  }
}
