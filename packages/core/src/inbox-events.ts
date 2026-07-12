import { z } from 'zod';

export const INBOX_PUBSUB_CHANNEL = 'notifyhub:inbox';
export const INBOX_MESSAGE_CREATED = 'inbox.message.created';

export const inboxEventMessageSchema = z
  .object({
    id: z.string().uuid(),
    notificationId: z.string().uuid(),
    title: z.string(),
    body: z.string(),
    readAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();

export const inboxMessageCreatedEventSchema = z
  .object({
    type: z.literal(INBOX_MESSAGE_CREATED),
    userId: z.string().min(1).max(128),
    message: inboxEventMessageSchema,
  })
  .strict();

export type InboxEventMessage = z.infer<typeof inboxEventMessageSchema>;
export type InboxMessageCreatedEvent = z.infer<typeof inboxMessageCreatedEventSchema>;
