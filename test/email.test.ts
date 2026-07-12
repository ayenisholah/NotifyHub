import { describe, expect, it, vi } from 'vitest';

import {
  createMailpitEmailProvider,
  createResendEmailProvider,
  createSendGridEmailProvider,
  renderEmailTemplate,
} from '../packages/workers/src/index.js';

const message = {
  to: 'reader@example.test',
  subject: 'Hello',
  text: 'Plain',
  html: '<b>HTML</b>',
  idempotencyKey: 'delivery-id',
};

describe('email templates', () => {
  it('renders plain fields unescaped and HTML fields escaped', () => {
    expect(
      renderEmailTemplate({
        event: 'comment.created',
        subject: '{{payload.author.name}} says',
        body: '{{payload.text}}',
        bodyHtml: '<p>{{payload.text}}</p>',
        context: { payload: { author: { name: 'Ada' }, text: '<hello>' } },
      }),
    ).toEqual({ subject: 'Ada says', text: '<hello>', html: '<p>&lt;hello&gt;</p>' });
  });

  it('falls back to the event and reports missing nested values', () => {
    const onWarning = vi.fn();
    expect(
      renderEmailTemplate({
        event: 'comment.created',
        subject: null,
        body: '{{payload.missing}}',
        bodyHtml: '{{user.name}}',
        context: { payload: {}, user: {} },
        onWarning,
      }),
    ).toEqual({ subject: 'comment.created', text: '', html: '' });
    expect(onWarning.mock.calls.map(([warning]) => warning)).toEqual([
      { field: 'text', path: 'payload.missing' },
      { field: 'html', path: 'user.name' },
    ]);
  });
});

describe('email provider adapters', () => {
  it('maps Mailpit SMTP messages and normalizes its message ID', async () => {
    const sendMail = vi.fn(async () => ({ messageId: '<smtp-id>' }));
    const provider = createMailpitEmailProvider(
      { provider: 'mailpit', from: 'from@example.test', host: 'mailpit', port: 1025 },
      { sendMail } as never,
    );
    await expect(provider.send(message)).resolves.toEqual({ providerMessageId: '<smtp-id>' });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'from@example.test',
        to: message.to,
        headers: { 'X-NotifyHub-Delivery-Id': 'delivery-id' },
      }),
    );
  });

  it('maps Resend JSON and its idempotency header', async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ id: 'resend-id' }), { status: 200 }),
    );
    const provider = createResendEmailProvider(
      { provider: 'resend', from: 'from@example.test', apiKey: 'private-resend-key' },
      { fetch },
    );
    await expect(provider.send(message)).resolves.toEqual({ providerMessageId: 'resend-id' });
    expect(fetch).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        headers: expect.objectContaining({ 'Idempotency-Key': 'delivery-id' }),
      }),
    );
  });

  it('maps SendGrid content and response message ID', async () => {
    const fetch = vi.fn(
      async () => new Response(null, { status: 202, headers: { 'x-message-id': 'sg-id' } }),
    );
    const provider = createSendGridEmailProvider(
      { provider: 'sendgrid', from: 'from@example.test', apiKey: 'private-sendgrid-key' },
      { fetch },
    );
    await expect(provider.send(message)).resolves.toEqual({ providerMessageId: 'sg-id' });
    const init = fetch.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      personalizations: [{ to: [{ email: message.to }] }],
      content: [{ type: 'text/plain' }, { type: 'text/html' }],
    });
  });

  it('sanitizes HTTP failures and rejects malformed success responses', async () => {
    const apiKey = 'private-resend-key';
    for (const response of [
      new Response('secret provider body', { status: 500 }),
      new Response('{}', { status: 200 }),
    ]) {
      const provider = createResendEmailProvider(
        { provider: 'resend', from: 'from@example.test', apiKey },
        { fetch: async () => response },
      );
      await expect(provider.send(message)).rejects.toThrow('resend email delivery failed');
      try {
        await provider.send(message);
      } catch (error) {
        expect((error as Error).message).not.toContain(apiKey);
        expect((error as Error).message).not.toContain('secret provider body');
      }
    }
  });
});
