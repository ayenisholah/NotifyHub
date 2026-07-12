import {
  DeliveryStatus,
  DeliveryTransitionConflictError,
  transitionDelivery,
  type DlqProducer,
  type PrismaClient,
} from '@notifyhub/core';

import { classifyDeliveryError } from './execution-error.js';

export async function parkFailedDelivery(
  prisma: PrismaClient,
  producer: Pick<DlqProducer, 'park'>,
  deliveryId: string,
  error: unknown,
): Promise<void> {
  const classified = classifyDeliveryError(error);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const delivery = await prisma.delivery.findUnique({ where: { id: deliveryId } });
    if (delivery === null || delivery.status === DeliveryStatus.SENT) return;
    if (delivery.status === DeliveryStatus.DLQ) {
      await producer.park(deliveryId);
      return;
    }
    if (delivery.status !== DeliveryStatus.FAILED) return;
    try {
      await transitionDelivery(prisma, {
        deliveryId,
        expectedStatus: DeliveryStatus.FAILED,
        status: DeliveryStatus.DLQ,
        attempts: delivery.attempts,
        lastError: delivery.lastError ?? classified.message,
        detail: {
          reason: 'delivery_dead_lettered',
          errorKind: classified.kind,
          retryable: classified.retryable,
          attempt: delivery.attempts,
        },
      });
      await producer.park(deliveryId);
      return;
    } catch (caught) {
      if (caught instanceof DeliveryTransitionConflictError && attempt < 2) continue;
      throw caught;
    }
  }
}
