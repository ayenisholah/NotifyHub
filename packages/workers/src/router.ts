import { Worker } from 'bullmq';

import {
  createDelivery,
  createRedisConnection,
  evaluateRouting,
  NotificationStatus,
  resolvePreference,
  ROUTE_QUEUE_NAME,
  type Channel,
  type ChannelJobEnqueuer,
  type PrismaClient,
  type RouteJobData,
} from '@notifyhub/core';

export const NO_TEMPLATES_REASON = 'no_templates';
export const PREFERENCES_DISABLED_REASON = 'preferences_disabled';

export type ProviderMapping = Readonly<Record<Channel, string>>;

export type RouteNotificationResult =
  | { status: typeof NotificationStatus.ROUTED; deliveryIds: string[] }
  | { status: typeof NotificationStatus.NO_OP; deliveryIds: [] };

export type RouteNotificationHandler = (notificationId: string) => Promise<RouteNotificationResult>;

export class NotificationNotFoundError extends Error {
  public constructor(notificationId: string) {
    super(`Notification not found: ${notificationId}`);
    this.name = 'NotificationNotFoundError';
  }
}

export class RouterConflictError extends Error {
  public constructor(notificationId: string) {
    super(`Notification routing did not stabilize: ${notificationId}`);
    this.name = 'RouterConflictError';
  }
}

type PreparedRoute = RouteNotificationResult | { retry: true };

export function createRouteNotificationHandler(
  prisma: PrismaClient,
  channelJobs: ChannelJobEnqueuer,
  providers: ProviderMapping,
): RouteNotificationHandler {
  for (const [channel, provider] of Object.entries(providers)) {
    if (provider.trim() === '') throw new Error(`Provider must not be empty for ${channel}`);
  }

  return async (notificationId) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const prepared: PreparedRoute = await prisma.$transaction(async (transaction) => {
        const notification = await transaction.notification.findUnique({
          where: { id: notificationId },
          include: {
            deliveries: { orderBy: { channel: 'asc' } },
            user: {
              select: { preferences: { select: { channel: true, category: true, enabled: true } } },
            },
          },
        });
        if (notification === null) throw new NotificationNotFoundError(notificationId);

        if (notification.status === NotificationStatus.NO_OP) {
          return { status: NotificationStatus.NO_OP, deliveryIds: [] };
        }
        if (notification.status === NotificationStatus.ROUTED) {
          if (notification.deliveries.length === 0) throw new RouterConflictError(notificationId);
          return {
            status: NotificationStatus.ROUTED,
            deliveryIds: notification.deliveries.map(({ id }) => id),
          };
        }

        const templates = await transaction.template.findMany({
          where: { event: notification.event, locale: 'en' },
          orderBy: { channel: 'asc' },
          select: { channel: true, digestEnabled: true },
        });
        if (templates.length === 0) {
          const updated = await transaction.notification.updateMany({
            where: { id: notificationId, status: NotificationStatus.ACCEPTED },
            data: { status: NotificationStatus.NO_OP, noOpReason: NO_TEMPLATES_REASON },
          });
          return updated.count === 1
            ? { status: NotificationStatus.NO_OP, deliveryIds: [] }
            : { retry: true };
        }

        const critical =
          typeof notification.payload === 'object' &&
          notification.payload !== null &&
          !Array.isArray(notification.payload) &&
          'critical' in notification.payload &&
          notification.payload.critical === true;
        const enabledTemplates = templates.flatMap((template) => {
          const preference = resolvePreference(
            notification.event,
            notification.user.preferences.filter(({ channel }) => channel === template.channel),
          );
          const decision = evaluateRouting({
            templatePresent: true,
            preferenceEnabled: preference.enabled,
            critical,
            quietHoursActive: false,
            digestEnabled: false,
          });
          return decision.outcome === 'skip' ? [] : [{ template, preference, decision }];
        });
        if (enabledTemplates.length === 0) {
          const updated = await transaction.notification.updateMany({
            where: { id: notificationId, status: NotificationStatus.ACCEPTED },
            data: { status: NotificationStatus.NO_OP, noOpReason: PREFERENCES_DISABLED_REASON },
          });
          return updated.count === 1
            ? { status: NotificationStatus.NO_OP, deliveryIds: [] }
            : { retry: true };
        }

        const updated = await transaction.notification.updateMany({
          where: { id: notificationId, status: NotificationStatus.ACCEPTED },
          data: { status: NotificationStatus.ROUTED, noOpReason: null },
        });
        if (updated.count !== 1) return { retry: true };

        const deliveries = [];
        for (const { template, preference, decision } of enabledTemplates) {
          const delivery = await createDelivery(transaction, {
            notificationId,
            channel: template.channel,
            provider: providers[template.channel],
            detail: {
              reason: decision.reason,
              locale: 'en',
              preferenceCategory: preference.matchedCategory,
            },
          });
          deliveries.push(delivery);
        }
        return {
          status: NotificationStatus.ROUTED,
          deliveryIds: deliveries.map(({ id }) => id),
        };
      });

      if ('retry' in prepared) continue;
      if (prepared.status === NotificationStatus.ROUTED) {
        const deliveries = await prisma.delivery.findMany({
          where: { id: { in: prepared.deliveryIds } },
          orderBy: { channel: 'asc' },
          select: { id: true, channel: true },
        });
        for (const delivery of deliveries) {
          await channelJobs.enqueue(delivery.channel, delivery.id);
        }
      }
      return prepared;
    }

    throw new RouterConflictError(notificationId);
  };
}

export interface RouteWorker {
  close(): Promise<void>;
}

export function createRouteWorker(
  redisUrl: string,
  routeNotification: RouteNotificationHandler,
): RouteWorker {
  const worker = new Worker<RouteJobData>(
    ROUTE_QUEUE_NAME,
    async (job) => routeNotification(job.data.notificationId),
    { connection: createRedisConnection(redisUrl) },
  );
  worker.on('error', () => undefined);

  return {
    async close() {
      await worker.close();
    },
  };
}
