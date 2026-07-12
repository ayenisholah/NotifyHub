import {
  DeliveryStatus,
  NotificationStatus,
  type ChannelJobEnqueuer,
  type DlqProducer,
  type DigestJobEnqueuer,
  type PrismaClient,
} from '@notifyhub/core';

import { parkFailedDelivery } from './dlq.js';

export interface ReconciliationResult {
  notifications: number;
  deliveries: number;
  deadLetters: number;
  digestBatches: number;
}

export interface ReconciliationDependencies {
  routeJobs: { enqueue(notificationId: string): Promise<void> };
  channelJobs: ChannelJobEnqueuer;
  dlq: Pick<DlqProducer, 'park'>;
  digestJobs?: DigestJobEnqueuer;
}

export async function reconcilePersistedWork(
  prisma: PrismaClient,
  dependencies: ReconciliationDependencies,
  cutoff: Date,
): Promise<ReconciliationResult> {
  const notifications = await prisma.notification.findMany({
    where: { status: NotificationStatus.ACCEPTED, createdAt: { lt: cutoff } },
    select: { id: true },
  });
  for (const notification of notifications) await dependencies.routeJobs.enqueue(notification.id);

  const active = await prisma.delivery.findMany({
    where: {
      status: {
        in: [
          DeliveryStatus.QUEUED,
          DeliveryStatus.SCHEDULED,
          DeliveryStatus.RETRYING,
          DeliveryStatus.PROCESSING,
        ],
      },
      updatedAt: { lt: cutoff },
    },
    select: { id: true, channel: true, scheduledFor: true, status: true },
  });
  for (const delivery of active) {
    await dependencies.channelJobs.enqueue(
      delivery.channel,
      delivery.id,
      delivery.status === DeliveryStatus.SCHEDULED
        ? (delivery.scheduledFor ?? undefined)
        : undefined,
    );
  }

  const terminal = await prisma.delivery.findMany({
    where: {
      status: { in: [DeliveryStatus.FAILED, DeliveryStatus.DLQ] },
      updatedAt: { lt: cutoff },
    },
    select: { id: true, status: true },
  });
  for (const delivery of terminal) {
    if (delivery.status === DeliveryStatus.FAILED) {
      await parkFailedDelivery(
        prisma,
        dependencies.dlq,
        delivery.id,
        new Error('reconciled failure'),
      );
    } else {
      await dependencies.dlq.park(delivery.id);
    }
  }

  const digestBatches =
    dependencies.digestJobs === undefined
      ? []
      : await prisma.digestBatch.findMany({
          where: { status: 'OPEN' },
          select: { id: true, windowEndsAt: true },
        });
  if (dependencies.digestJobs !== undefined) {
    for (const batch of digestBatches)
      await dependencies.digestJobs.enqueue(batch.id, batch.windowEndsAt);
  }

  return {
    notifications: notifications.length,
    deliveries: active.length,
    deadLetters: terminal.length,
    digestBatches: digestBatches.length,
  };
}
