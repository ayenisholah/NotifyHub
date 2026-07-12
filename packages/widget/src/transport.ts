import type { InboxClientEvent, InboxMessage } from './types.js';

export interface InboxPage {
  items: InboxMessage[];
  unreadCount: number;
  nextCursor: string | null;
}

export interface ReadAllResult {
  updatedCount: number;
  unreadCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseMessage(value: unknown): InboxMessage | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== 'string' ||
    typeof value.notificationId !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.body !== 'string' ||
    (value.readAt !== null && typeof value.readAt !== 'string') ||
    typeof value.createdAt !== 'string' ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    (typeof value.readAt === 'string' && Number.isNaN(Date.parse(value.readAt)))
  )
    return undefined;
  return value as unknown as InboxMessage;
}

export function parseInboxPage(value: unknown): InboxPage | undefined {
  if (!isRecord(value) || !Array.isArray(value.items)) return undefined;
  const items = value.items.map(parseMessage);
  if (
    items.some((item) => item === undefined) ||
    !Number.isInteger(value.unreadCount) ||
    (value.unreadCount as number) < 0 ||
    (value.nextCursor !== null && typeof value.nextCursor !== 'string')
  )
    return undefined;
  return {
    items: items as InboxMessage[],
    unreadCount: value.unreadCount as number,
    nextCursor: value.nextCursor as string | null,
  };
}

export function parseReadAllResult(value: unknown): ReadAllResult | undefined {
  if (
    !isRecord(value) ||
    !Number.isInteger(value.updatedCount) ||
    (value.updatedCount as number) < 0 ||
    !Number.isInteger(value.unreadCount) ||
    (value.unreadCount as number) < 0
  )
    return undefined;
  return value as unknown as ReadAllResult;
}

export function apiUrl(base: string, path: string): URL {
  return new URL(path, base === '' ? window.location.origin : `${base.replace(/\/$/, '')}/`);
}

export function webSocketUrl(base: string, token: string): string {
  const url = apiUrl(base, '/ws/inbox');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('token', token);
  return url.toString();
}

export function mergeMessages(
  current: InboxMessage[],
  incoming: InboxMessage[],
  prepend = false,
): InboxMessage[] {
  const map = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) map.set(message.id, message);
  const ids = prepend
    ? [...incoming.map(({ id }) => id), ...current.map(({ id }) => id)]
    : [...current.map(({ id }) => id), ...incoming.map(({ id }) => id)];
  return [...new Set(ids)]
    .map((id) => map.get(id)!)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

export function parseClientEvent(value: unknown): InboxClientEvent | undefined {
  if (!isRecord(value) || !('type' in value)) return undefined;
  const event = value as Record<string, unknown>;
  if (event.type === 'unread' && Number.isInteger(event.count) && (event.count as number) >= 0)
    return event as unknown as InboxClientEvent;
  if (event.type === 'message') {
    const message = parseMessage(event.message);
    if (message !== undefined) return { type: 'message', message };
  }
  return undefined;
}
