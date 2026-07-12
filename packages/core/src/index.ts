export { ConfigurationError, loadConfig, parseConfig } from './config.js';
export type { AppConfig } from './config.js';
export {
  Channel,
  createPrismaClient,
  DeliveryStatus,
  DigestBatchStatus,
  NotificationStatus,
  Prisma,
} from './database.js';
export type { Delivery, PrismaClient } from './database.js';
export {
  CHANNEL_JOB_NAME,
  CHANNEL_QUEUE_NAMES,
  createChannelQueueProducer,
} from './channel-queue.js';
export type { ChannelJobData, ChannelJobEnqueuer, ChannelQueueProducer } from './channel-queue.js';
export {
  createDelivery,
  DeliveryNotFoundError,
  DeliveryTransitionConflictError,
  InvalidDeliveryStateError,
  transitionDelivery,
} from './delivery-lifecycle.js';
export type { CreateDeliveryInput, TransitionDeliveryInput } from './delivery-lifecycle.js';
export {
  createRedisConnection,
  createRouteQueueProducer,
  ROUTE_JOB_NAME,
  ROUTE_QUEUE_NAME,
} from './route-queue.js';
export type { RouteJobData, RouteQueueProducer } from './route-queue.js';
export { evaluateRouting, resolvePreference, ROUTING_REASONS } from './routing-precedence.js';
export type {
  PreferenceResolution,
  PreferenceRule,
  RoutingDecision,
  RoutingEvaluationInput,
  RoutingReason,
} from './routing-precedence.js';

export const packageIdentity = '@notifyhub/core' as const;
