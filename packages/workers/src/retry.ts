import { UnrecoverableError } from 'bullmq';

import {
  DeliveryStatus,
  DeliveryTransitionConflictError,
  DELIVERY_MAX_ATTEMPTS,
  transitionDelivery,
  type PrismaClient,
} from '@notifyhub/core';

import { classifyDeliveryError } from './execution-error.js';

export type DeliveryFailureOutcome = 'retry' | 'failed' | 'completed';

export async function recordDeliveryFailure(
  prisma: PrismaClient,
  deliveryId: string,
  error: unknown,
): Promise<DeliveryFailureOutcome> {
  const classified = classifyDeliveryError(error);
  for (let conflict = 0; conflict < 3; conflict += 1) {
    const delivery = await prisma.delivery.findUnique({ where: { id: deliveryId } });
    if (delivery === null) return 'failed';
    if (delivery.status === DeliveryStatus.SENT) return 'completed';
    if (delivery.status === DeliveryStatus.FAILED || delivery.status === DeliveryStatus.DLQ)
      return 'failed';

    try {
      let attempts = delivery.attempts;
      if (delivery.status !== DeliveryStatus.PROCESSING) {
        attempts += 1;
        await transitionDelivery(prisma, {
          deliveryId,
          expectedStatus: delivery.status,
          status: DeliveryStatus.PROCESSING,
          attempts,
          detail: { reason: 'delivery_failure_claimed', errorKind: classified.kind },
        });
      }
      const retry = classified.retryable && attempts < DELIVERY_MAX_ATTEMPTS;
      await transitionDelivery(prisma, {
        deliveryId,
        expectedStatus: DeliveryStatus.PROCESSING,
        status: retry ? DeliveryStatus.RETRYING : DeliveryStatus.FAILED,
        attempts,
        lastError: classified.message,
        detail: {
          reason: retry ? 'delivery_retry_scheduled' : 'delivery_failed',
          errorKind: classified.kind,
          retryable: classified.retryable,
          attempt: attempts,
        },
      });
      return retry ? 'retry' : 'failed';
    } catch (caught) {
      if (caught instanceof DeliveryTransitionConflictError && conflict < 2) continue;
      throw caught;
    }
  }
  return 'failed';
}

export async function runClassifiedDelivery<T>(
  prisma: PrismaClient,
  deliveryId: string,
  handler: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await handler();
  } catch (error) {
    const outcome = await recordDeliveryFailure(prisma, deliveryId, error);
    if (outcome === 'completed') return undefined;
    if (outcome === 'retry') throw error;
    throw new UnrecoverableError(classifyDeliveryError(error).message);
  }
}
