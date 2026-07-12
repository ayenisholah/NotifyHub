import { packageIdentity as corePackage } from '@notifyhub/core';

export {
  createRouteNotificationHandler,
  createRouteWorker,
  NotificationNotFoundError,
  NO_TEMPLATES_REASON,
  PREFERENCES_DISABLED_REASON,
  RouterConflictError,
} from './router.js';
export type {
  ProviderMapping,
  RouteNotificationHandler,
  RouteNotificationResult,
  RouteWorker,
} from './router.js';
export {
  createInAppDeliveryHandler,
  createInboxPublisher,
  createInAppWorker,
  INBOX_MESSAGE_CREATED,
  INBOX_PUBSUB_CHANNEL,
  InAppDeliveryError,
  InAppDeliveryNotFoundError,
  InAppTemplateNotFoundError,
  renderInAppTemplate,
  toInboxMessageCreatedEvent,
} from './in-app.js';
export type {
  CloseableInboxPublisher,
  HandleInAppDeliveryOptions,
  InboxEventMessage,
  InboxMessageCreatedEvent,
  InboxPublisher,
  InAppDeliveryHandler,
  InAppWorker,
  RenderedInAppTemplate,
  RenderInAppTemplateInput,
  TemplateWarning,
} from './in-app.js';

export const packageIdentity = '@notifyhub/workers' as const;
export const dependencies = [corePackage] as const;
