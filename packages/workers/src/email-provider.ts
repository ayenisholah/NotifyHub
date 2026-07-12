import nodemailer, { type Transporter } from 'nodemailer';

import type { EmailConfig, EmailProviderName } from '@notifyhub/core';

import { ProviderDeliveryError } from './execution-error.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  idempotencyKey: string;
}

export interface EmailSendResult {
  providerMessageId: string;
}

export interface EmailProvider {
  readonly name: EmailProviderName;
  send(message: EmailMessage): Promise<EmailSendResult>;
}

export interface EmailHttpClient {
  fetch(input: string, init: RequestInit): Promise<Response>;
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  for (const field of ['status', 'responseCode']) {
    const value = (error as Record<string, unknown>)[field];
    if (typeof value === 'number') return value;
  }
  return undefined;
}

function isRetryableHttp(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function createMailpitEmailProvider(
  config: Extract<EmailConfig, { provider: 'mailpit' }>,
  transporter: Pick<Transporter, 'sendMail'> = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: false,
  }),
): EmailProvider {
  return {
    name: 'mailpit',
    async send(message) {
      try {
        const result = (await transporter.sendMail({
          from: config.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          ...(message.html === undefined ? {} : { html: message.html }),
          headers: { 'X-NotifyHub-Delivery-Id': message.idempotencyKey },
        })) as { messageId?: unknown };
        if (typeof result.messageId !== 'string' || result.messageId.length === 0)
          throw new Error('missing message id');
        return { providerMessageId: result.messageId };
      } catch (error) {
        const status = statusOf(error);
        throw new ProviderDeliveryError('mailpit', status === undefined || status < 500, {
          ...(status === undefined ? {} : { status }),
          label: 'mailpit email',
        });
      }
    },
  };
}

async function sendHttp(
  provider: 'resend' | 'sendgrid',
  client: EmailHttpClient,
  url: string,
  init: RequestInit,
  readId: (response: Response) => Promise<string | null>,
): Promise<EmailSendResult> {
  try {
    const response = await client.fetch(url, init);
    if (!response.ok)
      throw new ProviderDeliveryError(provider, isRetryableHttp(response.status), {
        status: response.status,
        label: `${provider} email`,
      });
    const providerMessageId = await readId(response);
    if (providerMessageId === null)
      throw new ProviderDeliveryError(provider, true, { label: `${provider} email` });
    return { providerMessageId };
  } catch (error) {
    if (error instanceof ProviderDeliveryError) throw error;
    const status = statusOf(error);
    throw new ProviderDeliveryError(provider, status === undefined || isRetryableHttp(status), {
      ...(status === undefined ? {} : { status }),
      label: `${provider} email`,
    });
  }
}

export function createResendEmailProvider(
  config: Extract<EmailConfig, { provider: 'resend' }>,
  client: EmailHttpClient = { fetch: globalThis.fetch },
): EmailProvider {
  return {
    name: 'resend',
    send: (message) =>
      sendHttp(
        'resend',
        client,
        'https://api.resend.com/emails',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': message.idempotencyKey,
          },
          body: JSON.stringify({
            from: config.from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
            ...(message.html === undefined ? {} : { html: message.html }),
          }),
        },
        async (response) => {
          const body = (await response.json()) as { id?: unknown };
          return typeof body.id === 'string' && body.id.length > 0 ? body.id : null;
        },
      ),
  };
}

export function createSendGridEmailProvider(
  config: Extract<EmailConfig, { provider: 'sendgrid' }>,
  client: EmailHttpClient = { fetch: globalThis.fetch },
): EmailProvider {
  return {
    name: 'sendgrid',
    send: (message) =>
      sendHttp(
        'sendgrid',
        client,
        'https://api.sendgrid.com/v3/mail/send',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: message.to }] }],
            from: { email: config.from },
            subject: message.subject,
            content: [
              { type: 'text/plain', value: message.text },
              ...(message.html === undefined ? [] : [{ type: 'text/html', value: message.html }]),
            ],
          }),
        },
        async (response) => response.headers.get('x-message-id'),
      ),
  };
}

export function createEmailProvider(config: EmailConfig): EmailProvider {
  switch (config.provider) {
    case 'mailpit':
      return createMailpitEmailProvider(config);
    case 'resend':
      return createResendEmailProvider(config);
    case 'sendgrid':
      return createSendGridEmailProvider(config);
  }
}
