import { z } from 'zod';

import {
  DeliveryStatus,
  DlqRetryConflictError,
  resetDlqDelivery,
  type DlqProducer,
  type PrismaClient,
} from '@notifyhub/core';

export interface DlqListItem {
  deliveryId: string;
  notificationId: string;
  event: string;
  channel: string;
  provider: string;
  attempts: number;
  lastError: string | null;
  deadLetteredAt: string;
}
export interface DlqListResult {
  items: DlqListItem[];
  nextCursor: string | null;
}
export type ListDlqHandler = (input: { limit: number; cursor?: string }) => Promise<DlqListResult>;
export type RetryDlqHandler = (deliveryId: string) => Promise<{ replayed: boolean }>;

export class DlqNotFoundError extends Error {
  public constructor(id: string) {
    super(`DLQ delivery not found: ${id}`);
    this.name = 'DlqNotFoundError';
  }
}
export { DlqRetryConflictError };

const cursorSchema = z.object({ updatedAt: z.string().datetime(), id: z.string().uuid() });
export function encodeDlqCursor(value: { updatedAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ updatedAt: value.updatedAt.toISOString(), id: value.id }),
  ).toString('base64url');
}
export function decodeDlqCursor(cursor: string): { updatedAt: Date; id: string } {
  try {
    const parsed = cursorSchema.parse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    );
    return { updatedAt: new Date(parsed.updatedAt), id: parsed.id };
  } catch {
    throw new Error('Invalid DLQ cursor');
  }
}

export function createPersistentDlqHandlers(
  prisma: PrismaClient,
  producer: Pick<DlqProducer, 'requeue'>,
): { list: ListDlqHandler; retry: RetryDlqHandler } {
  return {
    async list(input) {
      const cursor = input.cursor === undefined ? undefined : decodeDlqCursor(input.cursor);
      const rows = await prisma.delivery.findMany({
        where: {
          status: DeliveryStatus.DLQ,
          ...(cursor === undefined
            ? {}
            : {
                OR: [
                  { updatedAt: { lt: cursor.updatedAt } },
                  { updatedAt: cursor.updatedAt, id: { lt: cursor.id } },
                ],
              }),
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        include: { notification: { select: { event: true } } },
      });
      const page = rows.slice(0, input.limit);
      const last = page.at(-1);
      return {
        items: page.map((row) => ({
          deliveryId: row.id,
          notificationId: row.notificationId,
          event: row.notification.event,
          channel: row.channel,
          provider: row.provider,
          attempts: row.attempts,
          lastError: row.lastError,
          deadLetteredAt: row.updatedAt.toISOString(),
        })),
        nextCursor:
          rows.length > input.limit && last !== undefined
            ? encodeDlqCursor({ updatedAt: last.updatedAt, id: last.id })
            : null,
      };
    },
    async retry(deliveryId) {
      const delivery = await prisma.delivery.findUnique({ where: { id: deliveryId } });
      if (delivery === null) throw new DlqNotFoundError(deliveryId);
      const reset = await resetDlqDelivery(prisma, deliveryId);
      await producer.requeue(reset.channel, deliveryId);
      return { replayed: reset.replayed };
    },
  };
}
