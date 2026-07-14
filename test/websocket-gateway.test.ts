import { EventEmitter, once } from 'node:events';
import { createServer, type Server } from 'node:http';

import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createInboxWebSocketGateway,
  issueUserToken,
  type InboxEventSubscriber,
  type InboxGateway,
} from '../packages/api/src/index.js';
import { INBOX_MESSAGE_CREATED, INBOX_PUBSUB_CHANNEL } from '../packages/core/src/index.js';

const secret = 'websocket-user-token-secret-with-enough-entropy';
const now = new Date('2026-07-12T12:00:00.000Z');

class FakeSubscriber extends EventEmitter implements InboxEventSubscriber {
  subscribe = vi.fn(async () => 1);
  unsubscribe = vi.fn(async () => 1);
  quit = vi.fn(async () => 'OK');
  disconnect = vi.fn();
}

let server: Server | undefined;
let gateway: InboxGateway | undefined;
let clients: WebSocket[] = [];
interface MessageBuffer {
  queue: unknown[];
  waiters: Array<(value: unknown) => void>;
}
const messageBuffers = new WeakMap<WebSocket, MessageBuffer>();

afterEach(async () => {
  for (const client of clients) {
    client.on('error', () => undefined);
    if (client.readyState === WebSocket.OPEN) client.terminate();
  }
  clients = [];
  await gateway?.close();
  gateway = undefined;
  if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

async function setup(
  countUnread = vi.fn(async () => 0),
  options: { allowedOrigins?: readonly string[]; heartbeatIntervalMs?: number } = {},
) {
  const subscriber = new FakeSubscriber();
  server = createServer();
  gateway = await createInboxWebSocketGateway({
    server,
    redisUrl: 'redis://unused.test',
    tokenSecret: secret,
    countUnread,
    subscriber,
    verifyOptions: { now: () => now },
    ...options,
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Server did not bind');
  return { subscriber, countUnread, baseUrl: `ws://127.0.0.1:${address.port}` };
}

function token(userId: string, issuedAt = now, lifetimeSeconds = 60): string {
  return issueUserToken(userId, secret, { now: () => issuedAt, lifetimeSeconds }).token;
}

async function connect(url: string, origin?: string): Promise<WebSocket> {
  const client = new WebSocket(url, origin === undefined ? undefined : { origin });
  clients.push(client);
  const buffer: MessageBuffer = { queue: [], waiters: [] };
  messageBuffers.set(client, buffer);
  client.on('message', (data) => {
    const value: unknown = JSON.parse(data.toString());
    const waiter = buffer.waiters.shift();
    if (waiter === undefined) buffer.queue.push(value);
    else waiter(value);
  });
  await once(client, 'open');
  return client;
}

async function nextJson(client: WebSocket): Promise<unknown> {
  const buffer = messageBuffers.get(client);
  if (buffer === undefined) throw new Error('Client has no message buffer');
  const queued = buffer.queue.shift();
  if (queued !== undefined) return queued;
  return new Promise((resolve) => buffer.waiters.push(resolve));
}

async function rejectedStatus(url: string, origin?: string): Promise<number> {
  const client = new WebSocket(url, origin === undefined ? undefined : { origin });
  client.on('error', () => undefined);
  const [, response] = await once(client, 'unexpected-response');
  return response.statusCode ?? 0;
}

describe('authenticated inbox WebSocket gateway', () => {
  it.each([
    ['missing', ''],
    ['duplicate', `?token=${token('user-1')}&token=${token('user-1')}`],
    ['unknown query', `?token=${token('user-1')}&room=user-2`],
    ['malformed', '?token=not-a-token'],
    ['tampered', `?token=${token('user-1').slice(0, -1)}x`],
    ['future', `?token=${token('user-1', new Date(now.getTime() + 60_000))}`],
    ['expired', `?token=${token('user-1', new Date(now.getTime() - 60_000), 1)}`],
  ])('rejects %s credentials with a sanitized 401', async (_label, query) => {
    const { baseUrl } = await setup();
    expect(await rejectedStatus(`${baseUrl}/ws/inbox${query}`)).toBe(401);
  });

  it('propagates the verified subject and cleans empty rooms', async () => {
    const countUnread = vi.fn(async (userId: string) => (userId === 'user-1' ? 4 : 99));
    const { baseUrl } = await setup(countUnread);
    const client = await connect(`${baseUrl}/ws/inbox?token=${token('user-1')}`);
    expect(await nextJson(client)).toEqual({ type: 'unread', count: 4 });
    expect(countUnread).toHaveBeenCalledWith('user-1');
    expect(gateway?.rooms.socketCount('user-1')).toBe(1);
    client.close();
    await once(client, 'close');
    await vi.waitFor(() => expect(gateway?.rooms.size).toBe(0));
  });

  it('allows configured and origin-less clients while rejecting other browser origins', async () => {
    const { baseUrl } = await setup(
      vi.fn(async () => 0),
      {
        allowedOrigins: ['https://app.example.test'],
      },
    );
    const url = `${baseUrl}/ws/inbox?token=${token('user-1')}`;
    expect(await rejectedStatus(url, 'https://attacker.example.test')).toBe(401);
    const browser = await connect(url, 'https://app.example.test');
    const native = await connect(url);
    expect(await nextJson(browser)).toEqual({ type: 'unread', count: 0 });
    expect(await nextJson(native)).toEqual({ type: 'unread', count: 0 });
  });

  it('keeps responsive clients alive across heartbeat intervals', async () => {
    const { baseUrl } = await setup(
      vi.fn(async () => 0),
      { heartbeatIntervalMs: 10 },
    );
    const client = await connect(`${baseUrl}/ws/inbox?token=${token('user-1')}`);
    await nextJson(client);
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(client.readyState).toBe(WebSocket.OPEN);
  });

  it('isolates rooms and sends message before authoritative unread state', async () => {
    const counts = new Map([
      ['user-1', 0],
      ['user-2', 7],
    ]);
    const { baseUrl, subscriber } = await setup(async (userId) => counts.get(userId) ?? 0);
    const first = await connect(`${baseUrl}/ws/inbox?token=${token('user-1')}`);
    const second = await connect(`${baseUrl}/ws/inbox?token=${token('user-1')}`);
    const other = await connect(`${baseUrl}/ws/inbox?token=${token('user-2')}`);
    await Promise.all([nextJson(first), nextJson(second), nextJson(other)]);
    const otherMessage = vi.fn();
    other.on('message', otherMessage);
    counts.set('user-1', 1);
    const event = {
      type: INBOX_MESSAGE_CREATED,
      userId: 'user-1',
      message: {
        id: '11111111-1111-4111-8111-111111111111',
        notificationId: '22222222-2222-4222-8222-222222222222',
        title: 'Hello',
        body: 'Private',
        readAt: null,
        createdAt: now.toISOString(),
      },
    };
    const firstEvents = Promise.all([nextJson(first), nextJson(first)]);
    const secondEvents = Promise.all([nextJson(second), nextJson(second)]);
    subscriber.emit('message', INBOX_PUBSUB_CHANNEL, JSON.stringify(event));
    const expected = [
      { type: 'message', message: event.message },
      { type: 'unread', count: 1 },
    ];
    expect(await firstEvents).toEqual(expected);
    expect(await secondEvents).toEqual(expected);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(otherMessage).not.toHaveBeenCalled();
  });

  it('ignores invalid envelopes without exposing payloads to diagnostics', async () => {
    const onDiagnostic = vi.fn();
    const subscriber = new FakeSubscriber();
    server = createServer();
    gateway = await createInboxWebSocketGateway({
      server,
      redisUrl: 'redis://unused.test',
      tokenSecret: secret,
      countUnread: async () => 0,
      subscriber,
      onDiagnostic,
    });
    subscriber.emit('message', INBOX_PUBSUB_CHANNEL, '{secret payload');
    subscriber.emit('message', INBOX_PUBSUB_CHANNEL, JSON.stringify({ type: 'unknown' }));
    expect(onDiagnostic.mock.calls).toEqual([
      [{ code: 'invalid_inbox_event' }],
      [{ code: 'invalid_inbox_event' }],
    ]);
  });

  it('shuts down idempotently and releases listeners and transport', async () => {
    const { subscriber } = await setup();
    await Promise.all([gateway!.close(), gateway!.close()]);
    expect(subscriber.unsubscribe).toHaveBeenCalledOnce();
    expect(subscriber.quit).toHaveBeenCalledOnce();
    expect(server!.listenerCount('upgrade')).toBe(0);
  });
});
