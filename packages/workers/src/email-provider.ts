import nodemailer, { type Transporter } from 'nodemailer';

import type { EmailConfig, EmailProviderName } from '@notifyhub/core';

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

function providerFailure(provider: EmailProviderName, error: unknown): Error {
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? ` (HTTP ${String(error.status)})`
      : '';
  return new Error(`${provider} email delivery failed${status}`);
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
        throw providerFailure('mailpit', error);
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
    if (!response.ok) throw { status: response.status };
    const providerMessageId = await readId(response);
    if (providerMessageId === null) throw new Error('missing message id');
    return { providerMessageId };
  } catch (error) {
    throw providerFailure(provider, error);
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
