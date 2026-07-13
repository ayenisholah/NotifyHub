import {
  CHANNELS,
  DELIVERY_STATUSES,
  ERROR_CLASSIFICATIONS,
  EVENT_REASONS,
  NOTIFICATION_STATUSES,
  type Channel,
  type DashboardDeliveryDetail,
  type DashboardDeliveryStatus,
  type DashboardDlqItem,
  type DashboardDlqListResult,
  type DashboardErrorClassification,
  type DashboardEventReason,
  type DashboardNotificationDetail,
  type DashboardNotificationListItem,
  type DashboardNotificationListResult,
  type DashboardSummary,
  type DashboardTimelineEvent,
  type DeliveryStatus,
  type NotificationStatus,
  type RetryOutcome,
} from './types.js';

const PAGE_SIZE = 20;

export class DashboardApiError extends Error {
  public constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'DashboardApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new DashboardApiError('NotifyHub returned an invalid response.');
  return value;
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new DashboardApiError('NotifyHub returned an invalid response.');
  return value;
}

function timestamp(value: unknown): string {
  const parsed = requiredString(value);
  if (!Number.isFinite(Date.parse(parsed)))
    throw new DashboardApiError('NotifyHub returned an invalid response.');
  return parsed;
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new DashboardApiError('NotifyHub returned an invalid response.');
  return value;
}

function member<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T))
    throw new DashboardApiError('NotifyHub returned an invalid response.');
  return value as T;
}

function nullableMember<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return value === null ? null : member(value, allowed);
}

function parseDelivery(value: unknown): DashboardDeliveryStatus {
  const row = requiredRecord(value);
  return {
    deliveryId: requiredString(row.deliveryId),
    channel: member<Channel>(row.channel, CHANNELS),
    status: member<DeliveryStatus>(row.status, DELIVERY_STATUSES),
    attempts: count(row.attempts),
    createdAt: timestamp(row.createdAt),
    updatedAt: timestamp(row.updatedAt),
  };
}

function parseTimelineEvent(value: unknown): DashboardTimelineEvent {
  const row = requiredRecord(value);
  return {
    status: member<DeliveryStatus>(row.status, DELIVERY_STATUSES),
    createdAt: timestamp(row.createdAt),
    reason: nullableMember<DashboardEventReason>(row.reason, EVENT_REASONS),
    errorClassification: nullableMember<DashboardErrorClassification>(
      row.errorClassification,
      ERROR_CLASSIFICATIONS,
    ),
  };
}

function parseNotification(value: unknown): DashboardNotificationListItem {
  const row = requiredRecord(value);
  if (!Array.isArray(row.deliveries))
    throw new DashboardApiError('NotifyHub returned an invalid response.');
  return {
    notificationId: requiredString(row.notificationId),
    event: requiredString(row.event),
    status: member<NotificationStatus>(row.status, NOTIFICATION_STATUSES),
    reason: nullableMember<DashboardEventReason>(row.reason, EVENT_REASONS),
    createdAt: timestamp(row.createdAt),
    deliveries: row.deliveries.map(parseDelivery),
  };
}

function parseNotificationDetail(value: unknown): DashboardNotificationDetail {
  const notification = parseNotification(value);
  const row = requiredRecord(value);
  const rawDeliveries = row.deliveries;
  if (!Array.isArray(rawDeliveries))
    throw new DashboardApiError('NotifyHub returned an invalid response.');
  return {
    ...notification,
    deliveries: notification.deliveries.map((delivery, index): DashboardDeliveryDetail => {
      const rawDelivery = requiredRecord(rawDeliveries[index]);
      if (!Array.isArray(rawDelivery.timeline))
        throw new DashboardApiError('NotifyHub returned an invalid response.');
      return { ...delivery, timeline: rawDelivery.timeline.map(parseTimelineEvent) };
    }),
  };
}

function parsePage<T>(
  value: unknown,
  parseItem: (item: unknown) => T,
): {
  items: T[];
  nextCursor: string | null;
} {
  const page = requiredRecord(value);
  if (
    !Array.isArray(page.items) ||
    (page.nextCursor !== null && typeof page.nextCursor !== 'string')
  )
    throw new DashboardApiError('NotifyHub returned an invalid response.');
  return { items: page.items.map(parseItem), nextCursor: page.nextCursor };
}

function parseDlqItem(value: unknown): DashboardDlqItem {
  const row = requiredRecord(value);
  const status = member<DeliveryStatus>(row.status, DELIVERY_STATUSES);
  if (status !== 'DLQ') throw new DashboardApiError('NotifyHub returned an invalid response.');
  return {
    deliveryId: requiredString(row.deliveryId),
    notificationId: requiredString(row.notificationId),
    event: requiredString(row.event),
    channel: member<Channel>(row.channel, CHANNELS),
    status,
    attempts: count(row.attempts),
    createdAt: timestamp(row.createdAt),
    updatedAt: timestamp(row.updatedAt),
    reason: nullableMember<DashboardEventReason>(row.reason, EVENT_REASONS),
    errorClassification: nullableMember<DashboardErrorClassification>(
      row.errorClassification,
      ERROR_CLASSIFICATIONS,
    ),
  };
}

function url(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

async function getJson(baseUrl: string, path: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url(baseUrl, path), {
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok)
    throw new DashboardApiError(`Dashboard request failed (${response.status}).`, response.status);
  try {
    return await response.json();
  } catch {
    throw new DashboardApiError('NotifyHub returned an invalid response.');
  }
}

function pagePath(path: string, cursor?: string): string {
  const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (cursor !== undefined) query.set('cursor', cursor);
  return `${path}?${query.toString()}`;
}

export interface DashboardClient {
  summary(signal?: AbortSignal): Promise<DashboardSummary>;
  notifications(cursor?: string, signal?: AbortSignal): Promise<DashboardNotificationListResult>;
  notification(id: string, signal?: AbortSignal): Promise<DashboardNotificationDetail>;
  dlq(cursor?: string, signal?: AbortSignal): Promise<DashboardDlqListResult>;
  retry(deliveryId: string, operatorKey: string, signal?: AbortSignal): Promise<RetryOutcome>;
}

export function createDashboardClient(baseUrl = ''): DashboardClient {
  return {
    async summary(signal) {
      const body = requiredRecord(await getJson(baseUrl, '/v1/dashboard/summary', signal));
      return {
        sentToday: count(body.sentToday),
        inFlight: count(body.inFlight),
        failed: count(body.failed),
        dlq: count(body.dlq),
      };
    },
    async notifications(cursor, signal) {
      return parsePage(
        await getJson(baseUrl, pagePath('/v1/dashboard/notifications', cursor), signal),
        parseNotification,
      );
    },
    async notification(id, signal) {
      return parseNotificationDetail(
        await getJson(baseUrl, `/v1/dashboard/notifications/${encodeURIComponent(id)}`, signal),
      );
    },
    async dlq(cursor, signal) {
      return parsePage(
        await getJson(baseUrl, pagePath('/v1/dashboard/dlq', cursor), signal),
        parseDlqItem,
      );
    },
    async retry(deliveryId, operatorKey, signal) {
      const response = await fetch(
        url(baseUrl, `/v1/dlq/${encodeURIComponent(deliveryId)}/retry`),
        {
          method: 'POST',
          cache: 'no-store',
          ...(signal === undefined ? {} : { signal }),
          headers: { Authorization: `Bearer ${operatorKey}` },
        },
      );
      if (response.status === 200 || response.status === 202) return 'retried';
      if (response.status === 401) return 'unauthorized';
      if (response.status === 404) return 'removed';
      if (response.status === 409) return 'ineligible';
      throw new DashboardApiError(`Retry request failed (${response.status}).`, response.status);
    },
  };
}
