import { Worker } from 'bullmq';

import {
  Channel,
  createDeliveryBackoffStrategy,
  createRedisConnection,
  DeliveryStatus,
  DigestBatchStatus,
  DIGEST_QUEUE_NAME,
  type ChannelJobEnqueuer,
  type DigestJobData,
  type PrismaClient,
} from '@notifyhub/core';

import type { ProviderMapping } from './router.js';

export class DigestFlushError extends Error {}
export class DigestBatchNotFoundError extends DigestFlushError {
  constructor(id: string) {
    super(`Digest batch not found: ${id}`);
    this.name = 'DigestBatchNotFoundError';
  }
}
export class EmptyDigestBatchError extends DigestFlushError {
  constructor(id: string) {
    super(`Digest batch is empty: ${id}`);
    this.name = 'EmptyDigestBatchError';
  }
}
export class InvalidDigestBatchError extends DigestFlushError {
  constructor(id: string, reason: string) {
    super(`Invalid digest batch ${id}: ${reason}`);
    this.name = 'InvalidDigestBatchError';
  }
}
export class DigestFlushConsistencyError extends DigestFlushError {
  constructor(id: string) {
    super(`Flushed digest batch has no delivery: ${id}`);
    this.name = 'DigestFlushConsistencyError';
  }
}

export interface DigestFlushResult {
  batchId: string;
  deliveryId: string;
  replayed: boolean;
}
export type DigestFlushHandler = (batchId: string) => Promise<DigestFlushResult>;

export function createDigestFlushHandler(
  prisma: PrismaClient,
  channelJobs: ChannelJobEnqueuer,
  providers: ProviderMapping,
): DigestFlushHandler {
  return async (batchId) => {
    const result = await prisma.$transaction(async (tx) => {
      const batch = await tx.digestBatch.findUnique({
        where: { id: batchId },
        include: {
          delivery: { select: { id: true } },
          items: { orderBy: [{ createdAt: 'asc' }, { notificationId: 'asc' }] },
        },
      });
      if (batch === null) throw new DigestBatchNotFoundError(batchId);
      if (batch.status === DigestBatchStatus.FLUSHED) {
        if (batch.delivery === null) throw new DigestFlushConsistencyError(batchId);
        return { batchId, deliveryId: batch.delivery.id, replayed: true };
      }
      if (batch.channel === Channel.IN_APP)
        throw new InvalidDigestBatchError(batchId, 'in-app batches are unsupported');
      if (batch.items.length === 0) throw new EmptyDigestBatchError(batchId);
      const template = await tx.template.findUnique({
        where: {
          event_channel_locale: { event: batch.event, channel: batch.channel, locale: 'en' },
        },
      });
      if (template === null || !template.digestEnabled || template.digestBody === null)
        throw new InvalidDigestBatchError(batchId, 'enabled English digest template not found');

      const claimed = await tx.digestBatch.updateMany({
        where: { id: batchId, status: DigestBatchStatus.OPEN },
        data: { status: DigestBatchStatus.FLUSHED },
      });
      if (claimed.count !== 1) {
        const winner = await tx.delivery.findUnique({
          where: { digestBatchId: batchId },
          select: { id: true },
        });
        if (winner === null) throw new DigestFlushConsistencyError(batchId);
        return { batchId, deliveryId: winner.id, replayed: true };
      }
      const delivery = await tx.delivery.create({
        data: {
          notificationId: batch.items[0]!.notificationId,
          digestBatchId: batch.id,
          channel: batch.channel,
          provider: providers[batch.channel],
          status: DeliveryStatus.QUEUED,
          events: {
            create: {
              status: DeliveryStatus.QUEUED,
              detail: {
                reason: 'digest_flush',
                flushReason: 'window_elapsed',
                digestBatchId: batch.id,
                itemCount: batch.items.length,
                locale: 'en',
              },
            },
          },
        },
      });
      return { batchId, deliveryId: delivery.id, replayed: false };
    });
    const delivery = await prisma.delivery.findUniqueOrThrow({
      where: { id: result.deliveryId },
      select: { channel: true },
    });
    await channelJobs.enqueue(delivery.channel, result.deliveryId);
    return result;
  };
}

export interface DigestFlushWorker {
  close(): Promise<void>;
}
export function createDigestFlushWorker(
  redisUrl: string,
  handler: DigestFlushHandler,
): DigestFlushWorker {
  const worker = new Worker<DigestJobData>(
    DIGEST_QUEUE_NAME,
    async (job) => handler(job.data.batchId),
    {
      connection: createRedisConnection(redisUrl),
      settings: { backoffStrategy: createDeliveryBackoffStrategy() },
    },
  );
  worker.on('error', () => undefined);
  return {
    async close() {
      await worker.close();
    },
  };
}
