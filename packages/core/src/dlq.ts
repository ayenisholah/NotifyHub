import { Queue } from 'bullmq';

import { CHANNEL_JOB_NAME, CHANNEL_QUEUE_NAMES, type ChannelJobData } from './channel-queue.js';
import {
  DeliveryStatus,
  type Channel,
  type Prisma,
  type PrismaClient,
} from './generated/prisma/client.js';
import { createRedisConnection } from './route-queue.js';
import { DELIVERY_RETRY_JOB_OPTIONS } from './retry-policy.js';

export const DLQ_QUEUE_NAME = 'dlq';
export const DLQ_JOB_NAME = 'dead-letter-delivery';
export interface DlqJobData {
  deliveryId: string;
}

export interface DlqProducer {
  park(deliveryId: string): Promise<void>;
  requeue(channel: Channel, deliveryId: string): Promise<void>;
  close(): Promise<void>;
}

export function createDlqProducer(redisUrl: string): DlqProducer {
  const connection = createRedisConnection(redisUrl);
  const dlq = new Queue<DlqJobData>(DLQ_QUEUE_NAME, { connection });
  const channels = new Map(
    Object.values(CHANNEL_QUEUE_NAMES).map((name) => [
      name,
      new Queue<ChannelJobData>(name, { connection }),
    ]),
  );
  return {
    async park(deliveryId) {
      await dlq.add(DLQ_JOB_NAME, { deliveryId }, { jobId: deliveryId });
    },
    async requeue(channel, deliveryId) {
      const queue = channels.get(CHANNEL_QUEUE_NAMES[channel]);
      if (queue === undefined) throw new Error(`Unsupported channel: ${channel}`);
      const oldJob = await queue.getJob(deliveryId);
      if (oldJob !== undefined) await oldJob.remove();
      await queue.add(
        CHANNEL_JOB_NAME,
        { deliveryId },
        { ...DELIVERY_RETRY_JOB_OPTIONS, jobId: deliveryId },
      );
      const parked = await dlq.getJob(deliveryId);
      if (parked !== undefined) await parked.remove();
    },
    async close() {
      await Promise.all([
        dlq.close(),
        ...[...channels.values()].map(async (queue) => queue.close()),
      ]);
    },
  };
}

export class DlqRetryConflictError extends Error {
  public constructor(deliveryId: string) {
    super(`Delivery is not eligible for DLQ retry: ${deliveryId}`);
    this.name = 'DlqRetryConflictError';
  }
}

export async function resetDlqDelivery(
  prisma: PrismaClient,
  deliveryId: string,
): Promise<{ channel: Channel; replayed: boolean }> {
  return prisma.$transaction(async (transaction) => {
    const delivery = await transaction.delivery.findUnique({
      where: { id: deliveryId },
      include: { events: { orderBy: { id: 'desc' }, take: 1 } },
    });
    if (delivery === null) throw new DlqRetryConflictError(deliveryId);
    const recovering =
      delivery.status === DeliveryStatus.QUEUED &&
      delivery.attempts === 0 &&
      (delivery.events[0]?.detail as { reason?: unknown } | null)?.reason === 'operator_retry';
    if (recovering) return { channel: delivery.channel, replayed: true };
    if (delivery.status !== DeliveryStatus.DLQ) throw new DlqRetryConflictError(deliveryId);
    const updated = await transaction.delivery.updateMany({
      where: { id: deliveryId, status: DeliveryStatus.DLQ },
      data: {
        status: DeliveryStatus.QUEUED,
        attempts: 0,
        lastError: null,
        providerMessageId: null,
      },
    });
    if (updated.count !== 1) throw new DlqRetryConflictError(deliveryId);
    await transaction.deliveryEvent.create({
      data: {
        deliveryId,
        status: DeliveryStatus.QUEUED,
        detail: { reason: 'operator_retry' } satisfies Prisma.InputJsonValue,
      },
    });
    return { channel: delivery.channel, replayed: false };
  });
}
