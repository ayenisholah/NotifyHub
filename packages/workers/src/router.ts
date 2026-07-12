import { Worker } from 'bullmq';

import {
  Channel,
  createDelivery,
  createRedisConnection,
  DeliveryStatus,
  evaluateRouting,
  joinDigestBatch,
  NotificationStatus,
  resolvePreference,
  resolveQuietHours,
  ROUTE_QUEUE_NAME,
  type ChannelJobEnqueuer,
  type DigestJobEnqueuer,
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

type PreparedRoute =
  | { status: typeof NotificationStatus.ROUTED; deliveryIds: string[]; digestBatchIds: string[] }
  | { status: typeof NotificationStatus.NO_OP; deliveryIds: []; digestBatchIds: [] }
  | { retry: true };

export function createRouteNotificationHandler(
  prisma: PrismaClient,
  channelJobs: ChannelJobEnqueuer,
  providers: ProviderMapping,
  now: () => Date = () => new Date(),
  digestJobs: DigestJobEnqueuer = { enqueue: async () => undefined },
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
            digestItems: { select: { batchId: true } },
            user: {
              select: {
                timezone: true,
                quietHours: { select: { startMinute: true, endMinute: true } },
                preferences: { select: { channel: true, category: true, enabled: true } },
              },
            },
          },
        });
        if (notification === null) throw new NotificationNotFoundError(notificationId);

        if (notification.status === NotificationStatus.NO_OP) {
          return { status: NotificationStatus.NO_OP, deliveryIds: [], digestBatchIds: [] };
        }
        if (notification.status === NotificationStatus.ROUTED) {
          if (notification.deliveries.length === 0 && notification.digestItems.length === 0)
            throw new RouterConflictError(notificationId);
          return {
            status: NotificationStatus.ROUTED,
            deliveryIds: notification.deliveries.map(({ id }) => id),
            digestBatchIds: [...new Set(notification.digestItems.map(({ batchId }) => batchId))],
          };
        }

        const templates = await transaction.template.findMany({
          where: { event: notification.event, locale: 'en' },
          orderBy: { channel: 'asc' },
          select: {
            channel: true,
            digestEnabled: true,
            digestBody: true,
            digestWindowMinutes: true,
          },
        });
        if (templates.length === 0) {
          const updated = await transaction.notification.updateMany({
            where: { id: notificationId, status: NotificationStatus.ACCEPTED },
            data: { status: NotificationStatus.NO_OP, noOpReason: NO_TEMPLATES_REASON },
          });
          return updated.count === 1
            ? { status: NotificationStatus.NO_OP, deliveryIds: [], digestBatchIds: [] }
            : { retry: true };
        }

        const critical =
          typeof notification.payload === 'object' &&
          notification.payload !== null &&
          !Array.isArray(notification.payload) &&
          'critical' in notification.payload &&
          notification.payload.critical === true;
        const routedAt = now();
        const enabledTemplates = templates.flatMap((template) => {
          const preference = resolvePreference(
            notification.event,
            notification.user.preferences.filter(({ channel }) => channel === template.channel),
          );
          const quietHours =
            !preference.enabled ||
            critical ||
            template.channel === Channel.IN_APP ||
            notification.user.quietHours === null
              ? { active: false as const, scheduledFor: null }
              : resolveQuietHours({
                  now: routedAt,
                  timezone: notification.user.timezone,
                  ...notification.user.quietHours,
                });
          const decision = evaluateRouting({
            templatePresent: true,
            preferenceEnabled: preference.enabled,
            critical,
            quietHoursActive: quietHours.active,
            digestEnabled:
              template.channel !== Channel.IN_APP &&
              template.digestEnabled &&
              template.digestBody !== null,
          });
          return decision.outcome === 'skip'
            ? []
            : [{ template, preference, decision, scheduledFor: quietHours.scheduledFor }];
        });
        if (enabledTemplates.length === 0) {
          const updated = await transaction.notification.updateMany({
            where: { id: notificationId, status: NotificationStatus.ACCEPTED },
            data: { status: NotificationStatus.NO_OP, noOpReason: PREFERENCES_DISABLED_REASON },
          });
          return updated.count === 1
            ? { status: NotificationStatus.NO_OP, deliveryIds: [], digestBatchIds: [] }
            : { retry: true };
        }

        const updated = await transaction.notification.updateMany({
          where: { id: notificationId, status: NotificationStatus.ACCEPTED },
          data: { status: NotificationStatus.ROUTED, noOpReason: null },
        });
        if (updated.count !== 1) return { retry: true };

        const deliveries = [];
        const digestBatchIds = new Set<string>();
        for (const { template, preference, decision, scheduledFor } of enabledTemplates) {
          if (decision.outcome === 'digest') {
            const { batch } = await joinDigestBatch(transaction, {
              userId: notification.userId,
              event: notification.event,
              channel: template.channel,
              notificationId,
              routedAt,
              windowMinutes: template.digestWindowMinutes,
            });
            digestBatchIds.add(batch.id);
            continue;
          }
          const scheduled = decision.outcome === 'schedule';
          if (scheduled && scheduledFor === null) throw new RouterConflictError(notificationId);
          const delivery = await createDelivery(transaction, {
            notificationId,
            channel: template.channel,
            provider: providers[template.channel],
            ...(scheduled
              ? { initialStatus: DeliveryStatus.SCHEDULED, scheduledFor: scheduledFor! }
              : { initialStatus: DeliveryStatus.QUEUED }),
            detail: {
              reason: decision.reason,
              locale: 'en',
              preferenceCategory: preference.matchedCategory,
              ...(scheduled
                ? {
                    timezone: notification.user.timezone,
                    scheduledFor: scheduledFor!.toISOString(),
                  }
                : {}),
            },
          });
          deliveries.push(delivery);
        }
        return {
          status: NotificationStatus.ROUTED,
          deliveryIds: deliveries.map(({ id }) => id),
          digestBatchIds: [...digestBatchIds],
        };
      });

      if ('retry' in prepared) continue;
      if (prepared.status === NotificationStatus.ROUTED) {
        const deliveries = await prisma.delivery.findMany({
          where: { id: { in: prepared.deliveryIds } },
          orderBy: { channel: 'asc' },
          select: { id: true, channel: true, scheduledFor: true },
        });
        for (const delivery of deliveries) {
          await channelJobs.enqueue(
            delivery.channel,
            delivery.id,
            delivery.scheduledFor ?? undefined,
          );
        }
        const batches = await prisma.digestBatch.findMany({
          where: { id: { in: prepared.digestBatchIds }, status: 'OPEN' },
          select: { id: true, windowEndsAt: true },
        });
        for (const batch of batches) await digestJobs.enqueue(batch.id, batch.windowEndsAt);
      }
      return prepared.status === NotificationStatus.NO_OP
        ? { status: NotificationStatus.NO_OP, deliveryIds: [] }
        : { status: NotificationStatus.ROUTED, deliveryIds: prepared.deliveryIds };
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
