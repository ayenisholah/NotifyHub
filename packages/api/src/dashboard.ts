import { z } from 'zod';

import {
  DeliveryStatus,
  type Channel,
  type NotificationStatus,
  type PrismaClient,
} from '@notifyhub/core';

export const DASHBOARD_EVENT_REASONS = [
  'immediate',
  'critical',
  'quiet_hours',
  'digest',
  'no_template',
  'preference_disabled',
  'no_templates',
  'preferences_disabled',
  'digest_flush',
  'email_processing',
  'email_sent',
  'sms_processing',
  'sms_sent',
  'in_app_processing',
  'inbox_persisted',
  'delivery_failure_claimed',
  'delivery_retry_scheduled',
  'delivery_failed',
  'delivery_dead_lettered',
  'operator_retry',
] as const;

export type DashboardEventReason = (typeof DASHBOARD_EVENT_REASONS)[number];

export const DASHBOARD_ERROR_CLASSIFICATIONS = [
  'ClassifiedDeliveryError',
  'ProviderDeliveryError',
  'UnexpectedError',
  'MockSmsProviderError',
  'EmailDeliveryError',
  'EmailDeliveryNotFoundError',
  'EmailProviderMismatchError',
  'EmailTemplateNotFoundError',
  'SmsDeliveryError',
  'SmsDeliveryNotFoundError',
  'SmsProviderMismatchError',
  'SmsRecipientMissingError',
  'SmsTemplateNotFoundError',
] as const;

export type DashboardErrorClassification = (typeof DASHBOARD_ERROR_CLASSIFICATIONS)[number];

export interface DashboardSummary {
  sentToday: number;
  inFlight: number;
  failed: number;
  dlq: number;
}

export interface DashboardTimelineEvent {
  status: DeliveryStatus;
  createdAt: string;
  reason: DashboardEventReason | null;
  errorClassification: DashboardErrorClassification | null;
}

export interface DashboardDeliveryStatus {
  deliveryId: string;
  channel: Channel;
  status: DeliveryStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardNotificationListItem {
  notificationId: string;
  event: string;
  status: NotificationStatus;
  reason: DashboardEventReason | null;
  createdAt: string;
  deliveries: DashboardDeliveryStatus[];
}

export interface DashboardNotificationListResult {
  items: DashboardNotificationListItem[];
  nextCursor: string | null;
}

export interface DashboardDeliveryDetail extends DashboardDeliveryStatus {
  timeline: DashboardTimelineEvent[];
}

export interface DashboardNotificationDetail {
  notificationId: string;
  event: string;
  status: NotificationStatus;
  reason: DashboardEventReason | null;
  createdAt: string;
  deliveries: DashboardDeliveryDetail[];
}

export interface DashboardDlqItem {
  deliveryId: string;
  notificationId: string;
  event: string;
  channel: Channel;
  status: typeof DeliveryStatus.DLQ;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  reason: DashboardEventReason | null;
  errorClassification: DashboardErrorClassification | null;
}

export interface DashboardDlqListResult {
  items: DashboardDlqItem[];
  nextCursor: string | null;
}

export interface DashboardNotificationCursor {
  createdAt: Date;
  id: string;
}

export interface DashboardDlqCursor {
  updatedAt: Date;
  id: string;
}

export type GetDashboardSummaryHandler = () => Promise<DashboardSummary>;
export type ListDashboardNotificationsHandler = (input: {
  limit: number;
  cursor?: string;
}) => Promise<DashboardNotificationListResult>;
export type GetDashboardNotificationHandler = (
  notificationId: string,
) => Promise<DashboardNotificationDetail>;
export type ListDashboardDlqHandler = (input: {
  limit: number;
  cursor?: string;
}) => Promise<DashboardDlqListResult>;

export interface DashboardHandlers {
  summary: GetDashboardSummaryHandler;
  listNotifications: ListDashboardNotificationsHandler;
  getNotification: GetDashboardNotificationHandler;
  listDlq: ListDashboardDlqHandler;
}

export interface PersistentDashboardOptions {
  now?: () => Date;
}

export class DashboardNotificationNotFoundError extends Error {
  public constructor() {
    super('Dashboard notification not found');
    this.name = 'DashboardNotificationNotFoundError';
  }
}

export class InvalidDashboardNotificationCursorError extends Error {
  public constructor() {
    super('Invalid dashboard notification cursor');
    this.name = 'InvalidDashboardNotificationCursorError';
  }
}

export class InvalidDashboardDlqCursorError extends Error {
  public constructor() {
    super('Invalid dashboard DLQ cursor');
    this.name = 'InvalidDashboardDlqCursorError';
  }
}

const notificationCursorSchema = z
  .object({ createdAt: z.string().datetime(), id: z.string().uuid() })
  .strict();
const dlqCursorSchema = z
  .object({ updatedAt: z.string().datetime(), id: z.string().uuid() })
  .strict();

function encodeCursor(value: Readonly<Record<string, string>>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor(cursor: string): unknown {
  const decoded = Buffer.from(cursor, 'base64url');
  if (decoded.toString('base64url') !== cursor) throw new Error('Non-canonical cursor');
  return JSON.parse(decoded.toString('utf8')) as unknown;
}

export function encodeDashboardNotificationCursor(cursor: DashboardNotificationCursor): string {
  return encodeCursor({ createdAt: cursor.createdAt.toISOString(), id: cursor.id });
}

export function decodeDashboardNotificationCursor(cursor: string): DashboardNotificationCursor {
  try {
    const parsed = notificationCursorSchema.parse(decodeCursor(cursor));
    return { createdAt: new Date(parsed.createdAt), id: parsed.id };
  } catch {
    throw new InvalidDashboardNotificationCursorError();
  }
}

export function encodeDashboardDlqCursor(cursor: DashboardDlqCursor): string {
  return encodeCursor({ updatedAt: cursor.updatedAt.toISOString(), id: cursor.id });
}

export function decodeDashboardDlqCursor(cursor: string): DashboardDlqCursor {
  try {
    const parsed = dlqCursorSchema.parse(decodeCursor(cursor));
    return { updatedAt: new Date(parsed.updatedAt), id: parsed.id };
  } catch {
    throw new InvalidDashboardDlqCursorError();
  }
}

const eventReasons = new Set<string>(DASHBOARD_EVENT_REASONS);
const errorClassifications = new Set<string>(DASHBOARD_ERROR_CLASSIFICATIONS);

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function safeReason(value: unknown): DashboardEventReason | null {
  return typeof value === 'string' && eventReasons.has(value)
    ? (value as DashboardEventReason)
    : null;
}

function safeErrorClassification(value: unknown): DashboardErrorClassification | null {
  return typeof value === 'string' && errorClassifications.has(value)
    ? (value as DashboardErrorClassification)
    : null;
}

function safeDetail(
  detail: unknown,
): Pick<DashboardTimelineEvent, 'reason' | 'errorClassification'> {
  const value = record(detail);
  return {
    reason: safeReason(value?.reason),
    errorClassification: safeErrorClassification(value?.errorKind),
  };
}

function startOfUtcDay(value: Date): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), 0, 0, 0, 0),
  );
}

function normalizeDelivery(row: {
  id: string;
  channel: Channel;
  status: DeliveryStatus;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
}): DashboardDeliveryStatus {
  return {
    deliveryId: row.id,
    channel: row.channel,
    status: row.status,
    attempts: row.attempts,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function validateDemoUserId(demoUserId: string): void {
  if (demoUserId.length === 0 || demoUserId.length > 128) {
    throw new Error('demoUserId must contain 1-128 characters');
  }
}

export function createPersistentDashboardHandlers(
  prisma: PrismaClient,
  demoUserId: string,
  options: PersistentDashboardOptions = {},
): DashboardHandlers {
  const scopedDemoUserId = demoUserId.trim();
  validateDemoUserId(scopedDemoUserId);
  const now = options.now ?? (() => new Date());

  return {
    async summary() {
      const currentTime = now();
      const sentSince = startOfUtcDay(currentTime);
      const [sentDeliveries, inFlight, failed, dlq] = await prisma.$transaction([
        prisma.deliveryEvent.findMany({
          where: {
            status: DeliveryStatus.SENT,
            createdAt: { gte: sentSince, lte: currentTime },
            delivery: { notification: { userId: scopedDemoUserId } },
          },
          distinct: ['deliveryId'],
          select: { deliveryId: true },
        }),
        prisma.delivery.count({
          where: {
            notification: { userId: scopedDemoUserId },
            status: {
              in: [
                DeliveryStatus.QUEUED,
                DeliveryStatus.SCHEDULED,
                DeliveryStatus.PROCESSING,
                DeliveryStatus.RETRYING,
              ],
            },
          },
        }),
        prisma.delivery.count({
          where: { notification: { userId: scopedDemoUserId }, status: DeliveryStatus.FAILED },
        }),
        prisma.delivery.count({
          where: { notification: { userId: scopedDemoUserId }, status: DeliveryStatus.DLQ },
        }),
      ]);
      return { sentToday: sentDeliveries.length, inFlight, failed, dlq };
    },

    async listNotifications(input) {
      const cursor =
        input.cursor === undefined ? undefined : decodeDashboardNotificationCursor(input.cursor);
      const rows = await prisma.notification.findMany({
        where: {
          userId: scopedDemoUserId,
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
        select: {
          id: true,
          event: true,
          status: true,
          noOpReason: true,
          createdAt: true,
          deliveries: {
            orderBy: [{ channel: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              channel: true,
              status: true,
              attempts: true,
              createdAt: true,
              updatedAt: true,
            },
          },
        },
      });
      const page = rows.slice(0, input.limit);
      const last = page.at(-1);
      return {
        items: page.map((row) => ({
          notificationId: row.id,
          event: row.event,
          status: row.status,
          reason: safeReason(row.noOpReason),
          createdAt: row.createdAt.toISOString(),
          deliveries: row.deliveries.map(normalizeDelivery),
        })),
        nextCursor:
          rows.length > input.limit && last !== undefined
            ? encodeDashboardNotificationCursor({ createdAt: last.createdAt, id: last.id })
            : null,
      };
    },

    async getNotification(notificationId) {
      const row = await prisma.notification.findFirst({
        where: { id: notificationId, userId: scopedDemoUserId },
        select: {
          id: true,
          event: true,
          status: true,
          noOpReason: true,
          createdAt: true,
          deliveries: {
            orderBy: [{ channel: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              channel: true,
              status: true,
              attempts: true,
              createdAt: true,
              updatedAt: true,
              events: {
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                select: { status: true, createdAt: true, detail: true },
              },
            },
          },
        },
      });
      if (row === null) throw new DashboardNotificationNotFoundError();
      return {
        notificationId: row.id,
        event: row.event,
        status: row.status,
        reason: safeReason(row.noOpReason),
        createdAt: row.createdAt.toISOString(),
        deliveries: row.deliveries.map((delivery) => ({
          ...normalizeDelivery(delivery),
          timeline: delivery.events.map((event) => ({
            status: event.status,
            createdAt: event.createdAt.toISOString(),
            ...safeDetail(event.detail),
          })),
        })),
      };
    },

    async listDlq(input) {
      const cursor =
        input.cursor === undefined ? undefined : decodeDashboardDlqCursor(input.cursor);
      const rows = await prisma.delivery.findMany({
        where: {
          status: DeliveryStatus.DLQ,
          notification: { userId: scopedDemoUserId },
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
        select: {
          id: true,
          notificationId: true,
          channel: true,
          status: true,
          attempts: true,
          createdAt: true,
          updatedAt: true,
          notification: { select: { event: true } },
          events: {
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 1,
            select: { detail: true },
          },
        },
      });
      const page = rows.slice(0, input.limit);
      const last = page.at(-1);
      return {
        items: page.map((row) => ({
          deliveryId: row.id,
          notificationId: row.notificationId,
          event: row.notification.event,
          channel: row.channel,
          status: DeliveryStatus.DLQ,
          attempts: row.attempts,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          ...safeDetail(row.events[0]?.detail),
        })),
        nextCursor:
          rows.length > input.limit && last !== undefined
            ? encodeDashboardDlqCursor({ updatedAt: last.updatedAt, id: last.id })
            : null,
      };
    },
  };
}
