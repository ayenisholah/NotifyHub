import { Worker } from 'bullmq';
import { Redis } from 'ioredis';

import {
  Channel,
  CHANNEL_QUEUE_NAMES,
  createRedisConnection,
  createDeliveryBackoffStrategy,
  DeliveryStatus,
  DeliveryTransitionConflictError,
  INBOX_MESSAGE_CREATED,
  INBOX_PUBSUB_CHANNEL,
  transitionDeliveryInTransaction,
  type ChannelJobData,
  type InboxMessageCreatedEvent,
  type PrismaClient,
} from '@notifyhub/core';

import {
  renderTemplateField,
  type TemplateWarning as SharedTemplateWarning,
} from './template-renderer.js';

export interface InboxPublisher {
  publish(event: InboxMessageCreatedEvent): Promise<void>;
}

export interface CloseableInboxPublisher extends InboxPublisher {
  close(): Promise<void>;
}

export type TemplateWarning = SharedTemplateWarning<'title' | 'body'>;

export interface RenderInAppTemplateInput {
  event: string;
  subject: string | null;
  body: string;
  context: Record<string, unknown>;
  onWarning?: (warning: TemplateWarning) => void;
}

export interface RenderedInAppTemplate {
  title: string;
  body: string;
}

export function renderInAppTemplate(input: RenderInAppTemplateInput): RenderedInAppTemplate {
  const titleTemplate = input.subject ?? input.event;
  return {
    title: renderTemplateField(titleTemplate, 'title', input.context, false, input.onWarning),
    body: renderTemplateField(input.body, 'body', input.context, false, input.onWarning),
  };
}

export function toInboxMessageCreatedEvent(message: {
  id: string;
  notificationId: string;
  userId: string;
  title: string;
  body: string;
  readAt: Date | null;
  createdAt: Date;
}): InboxMessageCreatedEvent {
  return {
    type: INBOX_MESSAGE_CREATED,
    userId: message.userId,
    message: {
      id: message.id,
      notificationId: message.notificationId,
      title: message.title,
      body: message.body,
      readAt: message.readAt?.toISOString() ?? null,
      createdAt: message.createdAt.toISOString(),
    },
  };
}

export function createInboxPublisher(redisUrl: string): CloseableInboxPublisher {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  return {
    async publish(event) {
      await redis.publish(INBOX_PUBSUB_CHANNEL, JSON.stringify(event));
    },
    async close() {
      await redis.quit();
    },
  };
}

export class InAppDeliveryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InAppDeliveryError';
  }
}

export class InAppDeliveryNotFoundError extends InAppDeliveryError {
  public constructor(deliveryId: string) {
    super(`In-app delivery not found: ${deliveryId}`);
    this.name = 'InAppDeliveryNotFoundError';
  }
}

export class InAppTemplateNotFoundError extends InAppDeliveryError {
  public constructor(event: string) {
    super(`English in-app template not found: ${event}`);
    this.name = 'InAppTemplateNotFoundError';
  }
}

export interface HandleInAppDeliveryOptions {
  onTemplateWarning?: (warning: TemplateWarning) => void;
}

export type InAppDeliveryHandler = (deliveryId: string) => Promise<InboxMessageCreatedEvent>;

export function createInAppDeliveryHandler(
  prisma: PrismaClient,
  publisher: InboxPublisher,
  options: HandleInAppDeliveryOptions = {},
): InAppDeliveryHandler {
  return async (deliveryId) => {
    let event: InboxMessageCreatedEvent | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        event = await prisma.$transaction(async (transaction) => {
          const delivery = await transaction.delivery.findUnique({
            where: { id: deliveryId },
            include: { notification: { include: { user: true, inboxMessage: true } } },
          });
          if (delivery === null) throw new InAppDeliveryNotFoundError(deliveryId);
          if (delivery.channel !== Channel.IN_APP) {
            throw new InAppDeliveryError(`Delivery is not in-app: ${deliveryId}`);
          }
          if (delivery.status === DeliveryStatus.SENT) {
            if (delivery.notification.inboxMessage === null) {
              throw new InAppDeliveryError(`Sent delivery has no inbox message: ${deliveryId}`);
            }
            return toInboxMessageCreatedEvent(delivery.notification.inboxMessage);
          }
          if (
            delivery.status !== DeliveryStatus.QUEUED &&
            delivery.status !== DeliveryStatus.SCHEDULED &&
            delivery.status !== DeliveryStatus.PROCESSING
          ) {
            throw new InAppDeliveryError(`In-app delivery cannot run from ${delivery.status}`);
          }

          const template = await transaction.template.findUnique({
            where: {
              event_channel_locale: {
                event: delivery.notification.event,
                channel: Channel.IN_APP,
                locale: 'en',
              },
            },
          });
          if (template === null) throw new InAppTemplateNotFoundError(delivery.notification.event);
          const rendered = renderInAppTemplate({
            event: delivery.notification.event,
            subject: template.subject,
            body: template.body,
            context: {
              user: {
                id: delivery.notification.user.id,
                email: delivery.notification.user.email,
                phone: delivery.notification.user.phone,
                timezone: delivery.notification.user.timezone,
              },
              payload: delivery.notification.payload,
            },
            ...(options.onTemplateWarning === undefined
              ? {}
              : { onWarning: options.onTemplateWarning }),
          });

          if (delivery.status !== DeliveryStatus.PROCESSING) {
            await transitionDeliveryInTransaction(transaction, {
              deliveryId,
              expectedStatus: delivery.status,
              status: DeliveryStatus.PROCESSING,
              attempts: Math.max(1, delivery.attempts),
              detail: { reason: 'in_app_processing' },
            });
          }
          const message = await transaction.inboxMessage.upsert({
            where: { notificationId: delivery.notificationId },
            create: {
              notificationId: delivery.notificationId,
              userId: delivery.notification.userId,
              title: rendered.title,
              body: rendered.body,
            },
            update: {},
          });
          await transitionDeliveryInTransaction(transaction, {
            deliveryId,
            expectedStatus: DeliveryStatus.PROCESSING,
            status: DeliveryStatus.SENT,
            attempts: Math.max(1, delivery.attempts),
            providerMessageId: message.id,
            detail: { reason: 'inbox_persisted', inboxMessageId: message.id },
          });
          return toInboxMessageCreatedEvent(message);
        });
        break;
      } catch (error) {
        if (error instanceof DeliveryTransitionConflictError && attempt < 2) continue;
        throw error;
      }
    }
    if (event === undefined)
      throw new InAppDeliveryError(`In-app delivery did not stabilize: ${deliveryId}`);
    await publisher.publish(event);
    return event;
  };
}

export interface InAppWorker {
  close(): Promise<void>;
}

export function createInAppWorker(redisUrl: string, handler: InAppDeliveryHandler): InAppWorker {
  const worker = new Worker<ChannelJobData>(
    CHANNEL_QUEUE_NAMES[Channel.IN_APP],
    async (job) => handler(job.data.deliveryId),
    {
      connection: createRedisConnection(redisUrl),
      settings: { backoffStrategy: createDeliveryBackoffStrategy() },
    },
  );
  worker.on('error', () => undefined);
  return { close: async () => worker.close() };
}
