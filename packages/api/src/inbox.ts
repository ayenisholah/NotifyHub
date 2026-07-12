import { z } from 'zod';

import type { PrismaClient } from '@notifyhub/core';

import { issueUserToken, type IssuedUserToken } from './user-token.js';

export interface InboxMessage {
  id: string;
  notificationId: string;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}

export interface InboxCursor {
  createdAt: Date;
  id: string;
}

export interface InboxListResult {
  items: InboxMessage[];
  unreadCount: number;
  nextCursor: string | null;
}

export interface InboxReadAllResult {
  updatedCount: number;
  unreadCount: number;
}

export type IssueUserTokenHandler = (userId: string) => Promise<IssuedUserToken>;
export type ListInboxHandler = (
  userId: string,
  input: { limit: number; cursor?: string },
) => Promise<InboxListResult>;
export type ReadInboxMessageHandler = (userId: string, id: string) => Promise<InboxMessage>;
export type ReadAllInboxHandler = (userId: string) => Promise<InboxReadAllResult>;

export interface InboxHandlers {
  issueToken: IssueUserTokenHandler;
  list: ListInboxHandler;
  read: ReadInboxMessageHandler;
  readAll: ReadAllInboxHandler;
}

export class UserNotFoundError extends Error {
  public constructor() {
    super('User not found');
    this.name = 'UserNotFoundError';
  }
}

export class InboxMessageNotFoundError extends Error {
  public constructor() {
    super('Inbox message not found');
    this.name = 'InboxMessageNotFoundError';
  }
}

const cursorSchema = z.object({ createdAt: z.string().datetime(), id: z.string().uuid() }).strict();

export function encodeInboxCursor(cursor: InboxCursor): string {
  return Buffer.from(
    JSON.stringify({ createdAt: cursor.createdAt.toISOString(), id: cursor.id }),
  ).toString('base64url');
}

export function decodeInboxCursor(cursor: string): InboxCursor {
  try {
    const decoded = Buffer.from(cursor, 'base64url');
    if (decoded.toString('base64url') !== cursor) throw new Error('Non-canonical cursor');
    const parsed = cursorSchema.parse(JSON.parse(decoded.toString('utf8')));
    return { createdAt: new Date(parsed.createdAt), id: parsed.id };
  } catch {
    throw new Error('Invalid inbox cursor');
  }
}

function normalize(row: {
  id: string;
  notificationId: string;
  title: string;
  body: string;
  readAt: Date | null;
  createdAt: Date;
}): InboxMessage {
  return {
    id: row.id,
    notificationId: row.notificationId,
    title: row.title,
    body: row.body,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function createPersistentInboxHandlers(
  prisma: PrismaClient,
  tokenSecret: string,
  now: () => Date = () => new Date(),
): InboxHandlers {
  return {
    async issueToken(userId) {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
      if (user === null) throw new UserNotFoundError();
      return issueUserToken(user.id, tokenSecret, { now });
    },
    async list(userId, input) {
      const cursor = input.cursor === undefined ? undefined : decodeInboxCursor(input.cursor);
      const [rows, unreadCount] = await prisma.$transaction([
        prisma.inboxMessage.findMany({
          where: {
            userId,
            ...(cursor === undefined
              ? {}
              : {
                  OR: [
                    { createdAt: { lt: cursor.createdAt } },
                    { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                  ],
                }),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: input.limit + 1,
        }),
        prisma.inboxMessage.count({ where: { userId, readAt: null } }),
      ]);
      const page = rows.slice(0, input.limit);
      const last = page.at(-1);
      return {
        items: page.map(normalize),
        unreadCount,
        nextCursor:
          rows.length > input.limit && last !== undefined
            ? encodeInboxCursor({ createdAt: last.createdAt, id: last.id })
            : null,
      };
    },
    async read(userId, id) {
      return prisma.$transaction(async (transaction) => {
        await transaction.inboxMessage.updateMany({
          where: { id, userId, readAt: null },
          data: { readAt: now() },
        });
        const message = await transaction.inboxMessage.findFirst({ where: { id, userId } });
        if (message === null) throw new InboxMessageNotFoundError();
        return normalize(message);
      });
    },
    async readAll(userId) {
      return prisma.$transaction(async (transaction) => {
        const updated = await transaction.inboxMessage.updateMany({
          where: { userId, readAt: null },
          data: { readAt: now() },
        });
        const unreadCount = await transaction.inboxMessage.count({
          where: { userId, readAt: null },
        });
        return { updatedCount: updated.count, unreadCount };
      });
    },
  };
}
