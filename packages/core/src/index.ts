export { ConfigurationError, loadConfig, parseConfig } from './config.js';
export type { AppConfig } from './config.js';
export {
  Channel,
  createPrismaClient,
  DeliveryStatus,
  DigestBatchStatus,
  NotificationStatus,
} from './database.js';
export type { PrismaClient } from './database.js';

export const packageIdentity = '@notifyhub/core' as const;
