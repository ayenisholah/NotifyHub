import { Worker } from 'bullmq';

import {
  Channel,
  CHANNEL_QUEUE_NAMES,
  createRedisConnection,
  createDeliveryBackoffStrategy,
  createDlqProducer,
  DeliveryStatus,
  DeliveryTransitionConflictError,
  transitionDelivery,
  type ChannelJobData,
  type PrismaClient,
} from '@notifyhub/core';

import type { SmsProvider, SmsSendResult } from './sms-provider.js';
import { ClassifiedDeliveryError } from './execution-error.js';
import { parkFailedDelivery } from './dlq.js';
import { runClassifiedDelivery } from './retry.js';
import { renderTemplateField, type TemplateWarning } from './template-renderer.js';

export type SmsTemplateWarning = TemplateWarning<'text'>;
export interface RenderSmsTemplateInput {
  body: string;
  context: Record<string, unknown>;
  onWarning?: (warning: SmsTemplateWarning) => void;
}

export function renderSmsTemplate(input: RenderSmsTemplateInput): string {
  return renderTemplateField(input.body, 'text', input.context, false, input.onWarning);
}

export class SmsDeliveryError extends ClassifiedDeliveryError {
  public constructor(message: string) {
    super(message, false);
    this.name = 'SmsDeliveryError';
  }
}
export class SmsDeliveryNotFoundError extends SmsDeliveryError {
  public constructor(id: string) {
    super(`SMS delivery not found: ${id}`);
    this.name = 'SmsDeliveryNotFoundError';
  }
}
export class SmsProviderMismatchError extends SmsDeliveryError {
  public constructor(expected: string, actual: string) {
    super(`SMS provider mismatch: delivery uses ${actual}, worker uses ${expected}`);
    this.name = 'SmsProviderMismatchError';
  }
}
export class SmsRecipientMissingError extends SmsDeliveryError {
  public constructor(userId: string) {
    super(`SMS recipient phone is missing for user: ${userId}`);
    this.name = 'SmsRecipientMissingError';
  }
}
export class SmsTemplateNotFoundError extends SmsDeliveryError {
  public constructor(event: string) {
    super(`English SMS template not found: ${event}`);
    this.name = 'SmsTemplateNotFoundError';
  }
}

export interface HandleSmsDeliveryOptions {
  onTemplateWarning?: (warning: SmsTemplateWarning) => void;
}
export type SmsDeliveryHandler = ((deliveryId: string) => Promise<SmsSendResult>) & {
  readonly prisma: PrismaClient;
};
const active = new Map<string, Promise<SmsSendResult>>();

export function createSmsDeliveryHandler(
  prisma: PrismaClient,
  provider: SmsProvider,
  options: HandleSmsDeliveryOptions = {},
): SmsDeliveryHandler {
  const execute = async (deliveryId: string): Promise<SmsSendResult> => {
    const delivery = await prisma.delivery.findUnique({
      where: { id: deliveryId },
      include: { notification: { include: { user: true } } },
    });
    if (delivery === null) throw new SmsDeliveryNotFoundError(deliveryId);
    if (delivery.channel !== Channel.SMS)
      throw new SmsDeliveryError(`Delivery is not SMS: ${deliveryId}`);
    if (delivery.provider !== provider.name)
      throw new SmsProviderMismatchError(provider.name, delivery.provider);
    if (delivery.status === DeliveryStatus.SENT) {
      if (delivery.providerMessageId === null)
        throw new SmsDeliveryError(`Sent SMS has no provider message ID: ${deliveryId}`);
      return { providerMessageId: delivery.providerMessageId };
    }
    if (
      delivery.status !== DeliveryStatus.QUEUED &&
      delivery.status !== DeliveryStatus.SCHEDULED &&
      delivery.status !== DeliveryStatus.RETRYING &&
      delivery.status !== DeliveryStatus.PROCESSING
    )
      throw new SmsDeliveryError(`SMS delivery cannot run from ${delivery.status}`);
    const phone = delivery.notification.user.phone;
    if (phone === null || phone.trim() === '')
      throw new SmsRecipientMissingError(delivery.notification.user.id);

    const template = await prisma.template.findUnique({
      where: {
        event_channel_locale: {
          event: delivery.notification.event,
          channel: Channel.SMS,
          locale: 'en',
        },
      },
    });
    if (template === null) throw new SmsTemplateNotFoundError(delivery.notification.event);
    const text = renderSmsTemplate({
      body: template.body,
      context: {
        user: {
          id: delivery.notification.user.id,
          email: delivery.notification.user.email,
          phone,
          timezone: delivery.notification.user.timezone,
        },
        payload: delivery.notification.payload,
      },
      ...(options.onTemplateWarning === undefined ? {} : { onWarning: options.onTemplateWarning }),
    });

    const executionAttempt =
      delivery.status === DeliveryStatus.PROCESSING
        ? Math.max(1, delivery.attempts)
        : delivery.attempts + 1;
    if (delivery.status !== DeliveryStatus.PROCESSING) {
      try {
        await transitionDelivery(prisma, {
          deliveryId,
          expectedStatus: delivery.status,
          status: DeliveryStatus.PROCESSING,
          attempts: executionAttempt,
          detail: { reason: 'sms_processing', provider: provider.name },
        });
      } catch (error) {
        if (error instanceof DeliveryTransitionConflictError) return execute(deliveryId);
        throw error;
      }
    }

    const result = await provider.send({
      to: phone,
      text,
      idempotencyKey: deliveryId,
      attempt: executionAttempt,
    });
    await transitionDelivery(prisma, {
      deliveryId,
      expectedStatus: DeliveryStatus.PROCESSING,
      status: DeliveryStatus.SENT,
      providerMessageId: result.providerMessageId,
      detail: { reason: 'sms_sent', provider: provider.name },
    });
    return result;
  };

  const handler = (deliveryId: string) => {
    const existing = active.get(deliveryId);
    if (existing !== undefined) return existing;
    const promise = execute(deliveryId).finally(() => active.delete(deliveryId));
    active.set(deliveryId, promise);
    return promise;
  };
  return Object.assign(handler, { prisma });
}

export interface SmsWorker {
  close(): Promise<void>;
}
export function createSmsWorker(redisUrl: string, handler: SmsDeliveryHandler): SmsWorker {
  const dlq = createDlqProducer(redisUrl);
  const worker = new Worker<ChannelJobData>(
    CHANNEL_QUEUE_NAMES[Channel.SMS],
    async (job) =>
      runClassifiedDelivery(
        handler.prisma,
        job.data.deliveryId,
        async () => handler(job.data.deliveryId),
        async (error) => parkFailedDelivery(handler.prisma, dlq, job.data.deliveryId, error),
      ),
    {
      connection: createRedisConnection(redisUrl),
      settings: { backoffStrategy: createDeliveryBackoffStrategy() },
    },
  );
  worker.on('error', () => undefined);
  return {
    async close() {
      await worker.close();
      await dlq.close();
    },
  };
}
