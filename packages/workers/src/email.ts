import { Worker } from 'bullmq';

import {
  Channel,
  CHANNEL_QUEUE_NAMES,
  createRedisConnection,
  DeliveryStatus,
  DeliveryTransitionConflictError,
  transitionDelivery,
  type ChannelJobData,
  type PrismaClient,
} from '@notifyhub/core';

import type { EmailProvider, EmailSendResult } from './email-provider.js';
import { renderTemplateField, type TemplateWarning } from './template-renderer.js';

export type EmailTemplateField = 'subject' | 'text' | 'html';
export type EmailTemplateWarning = TemplateWarning<EmailTemplateField>;

export interface RenderEmailTemplateInput {
  event: string;
  subject: string | null;
  body: string;
  bodyHtml: string | null;
  context: Record<string, unknown>;
  onWarning?: (warning: EmailTemplateWarning) => void;
}

export interface RenderedEmailTemplate {
  subject: string;
  text: string;
  html?: string;
}

export function renderEmailTemplate(input: RenderEmailTemplateInput): RenderedEmailTemplate {
  const render = (template: string, field: EmailTemplateField, escapeHtml: boolean) =>
    renderTemplateField(template, field, input.context, escapeHtml, input.onWarning);
  return {
    subject: render(input.subject ?? input.event, 'subject', false),
    text: render(input.body, 'text', false),
    ...(input.bodyHtml === null ? {} : { html: render(input.bodyHtml, 'html', true) }),
  };
}

export class EmailDeliveryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'EmailDeliveryError';
  }
}
export class EmailDeliveryNotFoundError extends EmailDeliveryError {
  public constructor(id: string) {
    super(`Email delivery not found: ${id}`);
    this.name = 'EmailDeliveryNotFoundError';
  }
}
export class EmailProviderMismatchError extends EmailDeliveryError {
  public constructor(expected: string, actual: string) {
    super(`Email provider mismatch: delivery uses ${actual}, worker uses ${expected}`);
    this.name = 'EmailProviderMismatchError';
  }
}
export class EmailTemplateNotFoundError extends EmailDeliveryError {
  public constructor(event: string) {
    super(`English email template not found: ${event}`);
    this.name = 'EmailTemplateNotFoundError';
  }
}

export interface HandleEmailDeliveryOptions {
  onTemplateWarning?: (warning: EmailTemplateWarning) => void;
}
export type EmailDeliveryHandler = (deliveryId: string) => Promise<EmailSendResult>;

const active = new Map<string, Promise<EmailSendResult>>();

export function createEmailDeliveryHandler(
  prisma: PrismaClient,
  provider: EmailProvider,
  options: HandleEmailDeliveryOptions = {},
): EmailDeliveryHandler {
  const execute = async (deliveryId: string): Promise<EmailSendResult> => {
    const delivery = await prisma.delivery.findUnique({
      where: { id: deliveryId },
      include: { notification: { include: { user: true } } },
    });
    if (delivery === null) throw new EmailDeliveryNotFoundError(deliveryId);
    if (delivery.channel !== Channel.EMAIL)
      throw new EmailDeliveryError(`Delivery is not email: ${deliveryId}`);
    if (delivery.provider !== provider.name)
      throw new EmailProviderMismatchError(provider.name, delivery.provider);
    if (delivery.status === DeliveryStatus.SENT) {
      if (delivery.providerMessageId === null)
        throw new EmailDeliveryError(`Sent email has no provider message ID: ${deliveryId}`);
      return { providerMessageId: delivery.providerMessageId };
    }
    if (
      delivery.status !== DeliveryStatus.QUEUED &&
      delivery.status !== DeliveryStatus.SCHEDULED &&
      delivery.status !== DeliveryStatus.RETRYING &&
      delivery.status !== DeliveryStatus.PROCESSING
    )
      throw new EmailDeliveryError(`Email delivery cannot run from ${delivery.status}`);

    const template = await prisma.template.findUnique({
      where: {
        event_channel_locale: {
          event: delivery.notification.event,
          channel: Channel.EMAIL,
          locale: 'en',
        },
      },
    });
    if (template === null) throw new EmailTemplateNotFoundError(delivery.notification.event);
    const rendered = renderEmailTemplate({
      event: delivery.notification.event,
      subject: template.subject,
      body: template.body,
      bodyHtml: template.bodyHtml,
      context: {
        user: {
          id: delivery.notification.user.id,
          email: delivery.notification.user.email,
          phone: delivery.notification.user.phone,
          timezone: delivery.notification.user.timezone,
        },
        payload: delivery.notification.payload,
      },
      ...(options.onTemplateWarning === undefined ? {} : { onWarning: options.onTemplateWarning }),
    });

    if (delivery.status !== DeliveryStatus.PROCESSING) {
      try {
        await transitionDelivery(prisma, {
          deliveryId,
          expectedStatus: delivery.status,
          status: DeliveryStatus.PROCESSING,
          attempts: delivery.attempts + 1,
          detail: { reason: 'email_processing', provider: provider.name },
        });
      } catch (error) {
        if (error instanceof DeliveryTransitionConflictError) return execute(deliveryId);
        throw error;
      }
    }

    const result = await provider.send({
      to: delivery.notification.user.email,
      ...rendered,
      idempotencyKey: deliveryId,
    });
    await transitionDelivery(prisma, {
      deliveryId,
      expectedStatus: DeliveryStatus.PROCESSING,
      status: DeliveryStatus.SENT,
      providerMessageId: result.providerMessageId,
      detail: { reason: 'email_sent', provider: provider.name },
    });
    return result;
  };

  return (deliveryId) => {
    const existing = active.get(deliveryId);
    if (existing !== undefined) return existing;
    const promise = execute(deliveryId).finally(() => active.delete(deliveryId));
    active.set(deliveryId, promise);
    return promise;
  };
}

export interface EmailWorker {
  close(): Promise<void>;
}
export function createEmailWorker(redisUrl: string, handler: EmailDeliveryHandler): EmailWorker {
  const worker = new Worker<ChannelJobData>(
    CHANNEL_QUEUE_NAMES[Channel.EMAIL],
    async (job) => handler(job.data.deliveryId),
    { connection: createRedisConnection(redisUrl) },
  );
  worker.on('error', () => undefined);
  return { close: async () => worker.close() };
}
