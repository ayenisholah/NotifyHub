import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';

import { Redis } from 'ioredis';
import { WebSocket, WebSocketServer } from 'ws';

import {
  inboxMessageCreatedEventSchema,
  INBOX_PUBSUB_CHANNEL,
  type InboxMessageCreatedEvent,
} from '@notifyhub/core';

import type { CountUnreadInboxHandler, InboxMessage } from './inbox.js';
import {
  InvalidUserTokenError,
  verifyUserToken,
  type VerifyUserTokenOptions,
} from './user-token.js';

export type InboxGatewayClientEvent =
  { type: 'message'; message: InboxMessage } | { type: 'unread'; count: number };

export type InboxGatewayDiagnosticCode =
  'subscriber_error' | 'invalid_inbox_event' | 'unread_count_error';

export interface InboxGatewayDiagnostic {
  code: InboxGatewayDiagnosticCode;
  error?: unknown;
}

export type InboxGatewayDiagnosticHandler = (diagnostic: InboxGatewayDiagnostic) => void;

export interface InboxGatewayLifecycle {
  close(): Promise<void>;
}

export interface InboxGatewayRooms {
  readonly size: number;
  socketCount(userId: string): number;
}

export interface InboxGateway extends InboxGatewayLifecycle {
  readonly rooms: InboxGatewayRooms;
}

export interface CreateInboxGatewayOptions {
  server: HttpServer;
  redisUrl: string;
  tokenSecret: string;
  countUnread: CountUnreadInboxHandler;
  verifyOptions?: VerifyUserTokenOptions;
  onDiagnostic?: InboxGatewayDiagnosticHandler;
  subscriber?: InboxEventSubscriber;
}

export interface InboxEventSubscriber {
  on(event: 'message', listener: (channel: string, payload: string) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  off(event: 'message', listener: (channel: string, payload: string) => void): unknown;
  off(event: 'error', listener: (error: Error) => void): unknown;
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  quit(): Promise<unknown>;
  disconnect(): unknown;
}

const unauthorizedBody = '{"error":{"code":"unauthorized","message":"Valid user token required"}}';
const unauthorizedResponse = `HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(unauthorizedBody)}\r\n\r\n${unauthorizedBody}`;

function rejectUpgrade(socket: Socket): void {
  if (socket.destroyed) return;
  socket.end(unauthorizedResponse);
}

function send(socket: WebSocket, event: InboxGatewayClientEvent): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
}

function parseUpgradeSubject(
  requestUrl: string | undefined,
  tokenSecret: string,
  verifyOptions: VerifyUserTokenOptions | undefined,
): string | undefined {
  try {
    const url = new URL(requestUrl ?? '', 'http://notifyhub.local');
    if (url.pathname !== '/ws/inbox') return undefined;
    if ([...url.searchParams.keys()].some((key) => key !== 'token')) return undefined;
    const tokens = url.searchParams.getAll('token');
    if (tokens.length !== 1 || tokens[0] === '') return undefined;
    return verifyUserToken(tokens[0]!, tokenSecret, verifyOptions).sub;
  } catch (error) {
    if (!(error instanceof InvalidUserTokenError) && !(error instanceof TypeError)) throw error;
    return undefined;
  }
}

export async function createInboxWebSocketGateway(
  options: CreateInboxGatewayOptions,
): Promise<InboxGateway> {
  const webSockets = new WebSocketServer({ noServer: true });
  const subscriber: InboxEventSubscriber =
    options.subscriber ?? new Redis(options.redisUrl, { maxRetriesPerRequest: null });
  const rooms = new Map<string, Set<WebSocket>>();
  let closing: Promise<void> | undefined;

  const diagnostic = (value: InboxGatewayDiagnostic): void => options.onDiagnostic?.(value);

  const onUpgrade = (request: IncomingMessage, socket: Socket, head: Buffer): void => {
    if (closing !== undefined) {
      rejectUpgrade(socket);
      return;
    }
    const userId = parseUpgradeSubject(request.url, options.tokenSecret, options.verifyOptions);
    if (userId === undefined) {
      rejectUpgrade(socket);
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      webSockets.emit('connection', webSocket, request, userId);
    });
  };

  webSockets.on('connection', (socket: WebSocket, _request: IncomingMessage, userId: string) => {
    const room = rooms.get(userId) ?? new Set<WebSocket>();
    room.add(socket);
    rooms.set(userId, room);
    socket.once('close', () => {
      room.delete(socket);
      if (room.size === 0) rooms.delete(userId);
    });
    void options.countUnread(userId).then(
      (count) => send(socket, { type: 'unread', count }),
      (error: unknown) => diagnostic({ code: 'unread_count_error', error }),
    );
  });

  const routeEvent = (event: InboxMessageCreatedEvent): void => {
    const room = rooms.get(event.userId);
    if (room === undefined) return;
    for (const socket of room) send(socket, { type: 'message', message: event.message });
    void options.countUnread(event.userId).then(
      (count) => {
        const currentRoom = rooms.get(event.userId);
        if (currentRoom === undefined) return;
        for (const socket of currentRoom) send(socket, { type: 'unread', count });
      },
      (error: unknown) => diagnostic({ code: 'unread_count_error', error }),
    );
  };

  const onMessage = (channel: string, payload: string): void => {
    if (channel !== INBOX_PUBSUB_CHANNEL) return;
    try {
      const parsed = inboxMessageCreatedEventSchema.safeParse(JSON.parse(payload));
      if (!parsed.success) {
        diagnostic({ code: 'invalid_inbox_event' });
        return;
      }
      routeEvent(parsed.data);
    } catch {
      diagnostic({ code: 'invalid_inbox_event' });
    }
  };
  const onSubscriberError = (error: Error): void => diagnostic({ code: 'subscriber_error', error });

  subscriber.on('message', onMessage);
  subscriber.on('error', onSubscriberError);
  await subscriber.subscribe(INBOX_PUBSUB_CHANNEL);
  options.server.on('upgrade', onUpgrade);

  return {
    rooms: {
      get size() {
        return rooms.size;
      },
      socketCount(userId) {
        return rooms.get(userId)?.size ?? 0;
      },
    },
    close() {
      closing ??= (async () => {
        options.server.off('upgrade', onUpgrade);
        subscriber.off('message', onMessage);
        subscriber.off('error', onSubscriberError);
        await subscriber.unsubscribe(INBOX_PUBSUB_CHANNEL).catch(() => undefined);
        for (const socket of webSockets.clients) socket.close(1001, 'Gateway shutting down');
        await new Promise<void>((resolve) => webSockets.close(() => resolve()));
        rooms.clear();
        await subscriber.quit().catch(() => subscriber.disconnect());
      })();
      return closing;
    },
  };
}
