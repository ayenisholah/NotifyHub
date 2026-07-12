import { randomUUID } from 'node:crypto';

import { Queue } from 'bullmq';

import {
  DigestBatchStatus,
  Prisma,
  type Channel,
  type DigestBatch,
} from './generated/prisma/client.js';
import { createRedisConnection } from './route-queue.js';
import { DELIVERY_RETRY_JOB_OPTIONS } from './retry-policy.js';

export const DIGEST_QUEUE_NAME = 'digest-flush';
export const DIGEST_JOB_NAME = 'flush-digest';
export interface DigestJobData {
  batchId: string;
}
export interface DigestJobEnqueuer {
  enqueue(batchId: string, windowEndsAt: Date): Promise<void>;
}
export interface DigestQueueProducer extends DigestJobEnqueuer {
  close(): Promise<void>;
}

export function createDigestQueueProducer(redisUrl: string): DigestQueueProducer {
  const queue = new Queue<DigestJobData>(DIGEST_QUEUE_NAME, {
    connection: createRedisConnection(redisUrl),
  });
  return {
    async enqueue(batchId, windowEndsAt) {
      await queue.add(
        DIGEST_JOB_NAME,
        { batchId },
        {
          ...DELIVERY_RETRY_JOB_OPTIONS,
          jobId: batchId,
          delay: Math.max(0, windowEndsAt.getTime() - Date.now()),
        },
      );
    },
    async close() {
      await queue.close();
    },
  };
}

export interface JoinDigestBatchInput {
  userId: string;
  event: string;
  channel: Channel;
  notificationId: string;
  routedAt: Date;
  windowMinutes: number;
}
export interface JoinDigestBatchResult {
  batch: DigestBatch;
  created: boolean;
}
type DigestTransaction = Pick<Prisma.TransactionClient, 'digestBatch' | 'digestItem' | '$queryRaw'>;

export async function joinDigestBatch(
  prisma: DigestTransaction,
  input: JoinDigestBatchInput,
): Promise<JoinDigestBatchResult> {
  const id = randomUUID();
  const windowEndsAt = new Date(input.routedAt.getTime() + input.windowMinutes * 60_000);
  const rows = await prisma.$queryRaw<Array<DigestBatch & { inserted: boolean }>>(Prisma.sql`
    INSERT INTO "digest_batches" ("id", "user_id", "event", "channel", "window_ends_at", "status")
    VALUES (${id}::uuid, ${input.userId}, ${input.event}, ${input.channel}::"Channel", ${windowEndsAt}, 'OPEN'::"DigestBatchStatus")
    ON CONFLICT ("user_id", "event", "channel") WHERE "status" = 'OPEN'
    DO UPDATE SET "user_id" = EXCLUDED."user_id"
    RETURNING "id", "user_id" AS "userId", "event", "channel", "window_ends_at" AS "windowEndsAt", "status", (xmax = 0) AS "inserted"
  `);
  const row = rows[0];
  if (row === undefined) throw new Error('Digest batch upsert returned no row');
  await prisma.digestItem.createMany({
    data: [{ batchId: row.id, notificationId: input.notificationId }],
    skipDuplicates: true,
  });
  return {
    batch: {
      id: row.id,
      userId: row.userId,
      event: row.event,
      channel: row.channel,
      windowEndsAt: row.windowEndsAt,
      status: row.status ?? DigestBatchStatus.OPEN,
    },
    created: row.inserted,
  };
}
