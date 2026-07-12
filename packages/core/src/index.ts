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
export type { PrismaClient } from './database.js';
export { createRouteQueueProducer, ROUTE_JOB_NAME, ROUTE_QUEUE_NAME } from './route-queue.js';
export type { RouteJobData, RouteQueueProducer } from './route-queue.js';

export const packageIdentity = '@notifyhub/core' as const;
