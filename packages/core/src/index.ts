export { ConfigurationError, loadConfig, parseConfig } from './config.js';
export type {
  AppConfig,
  EmailConfig,
  EmailProviderName,
  SmsConfig,
  SmsProviderName,
} from './config.js';
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
  transitionDeliveryInTransaction,
} from './delivery-lifecycle.js';
export type {
  CreateDeliveryInput,
  DeliveryTransitionClient,
  TransitionDeliveryInput,
} from './delivery-lifecycle.js';
export {
  createRedisConnection,
  createRouteQueueProducer,
  ROUTE_JOB_NAME,
  ROUTE_QUEUE_NAME,
} from './route-queue.js';
export type { RouteJobData, RouteQueueProducer } from './route-queue.js';
export {
  createDlqProducer,
  DLQ_JOB_NAME,
  DLQ_QUEUE_NAME,
  DlqRetryConflictError,
  resetDlqDelivery,
} from './dlq.js';
export type { DlqJobData, DlqProducer } from './dlq.js';
export {
  createDigestQueueProducer,
  DIGEST_JOB_NAME,
  DIGEST_QUEUE_NAME,
  joinDigestBatch,
} from './digest.js';
export type {
  DigestJobData,
  DigestJobEnqueuer,
  DigestQueueProducer,
  JoinDigestBatchInput,
  JoinDigestBatchResult,
} from './digest.js';
export {
  calculateDeliveryBackoff,
  createDeliveryBackoffStrategy,
  DELIVERY_BACKOFF_BASE_MS,
  DELIVERY_BACKOFF_TYPE,
  DELIVERY_MAX_ATTEMPTS,
  DELIVERY_RETRY_JOB_OPTIONS,
} from './retry-policy.js';
export { InvalidQuietHoursError, resolveQuietHours } from './quiet-hours.js';
export type { QuietHoursInput, QuietHoursResult } from './quiet-hours.js';
export {
  inboxEventMessageSchema,
  inboxMessageCreatedEventSchema,
  INBOX_MESSAGE_CREATED,
  INBOX_PUBSUB_CHANNEL,
} from './inbox-events.js';
export type { InboxEventMessage, InboxMessageCreatedEvent } from './inbox-events.js';
export { evaluateRouting, resolvePreference, ROUTING_REASONS } from './routing-precedence.js';
export type {
  PreferenceResolution,
  PreferenceRule,
  RoutingDecision,
  RoutingEvaluationInput,
  RoutingReason,
} from './routing-precedence.js';
export {
  closeHttpServer,
  createLogger,
  createOperationalMetrics,
  createOperationalRequestListener,
  createOperationalState,
  createShutdownController,
  startOperationalServer,
} from './operations.js';
export type {
  OperationalMetrics,
  OperationalState,
  ReadinessCheck,
  ServiceRole,
  ShutdownController,
} from './operations.js';

export const packageIdentity = '@notifyhub/core' as const;
