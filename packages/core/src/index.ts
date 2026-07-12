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
  createDelivery,
  DeliveryNotFoundError,
  DeliveryTransitionConflictError,
  InvalidDeliveryStateError,
  transitionDelivery,
} from './delivery-lifecycle.js';
export type { CreateDeliveryInput, TransitionDeliveryInput } from './delivery-lifecycle.js';
export { createRouteQueueProducer, ROUTE_JOB_NAME, ROUTE_QUEUE_NAME } from './route-queue.js';
export type { RouteJobData, RouteQueueProducer } from './route-queue.js';

export const packageIdentity = '@notifyhub/core' as const;
