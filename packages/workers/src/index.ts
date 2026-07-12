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
export {
  createEmailProvider,
  createMailpitEmailProvider,
  createResendEmailProvider,
  createSendGridEmailProvider,
} from './email-provider.js';
export type {
  EmailHttpClient,
  EmailMessage,
  EmailProvider,
  EmailSendResult,
} from './email-provider.js';
export {
  createEmailDeliveryHandler,
  createEmailWorker,
  EmailDeliveryError,
  EmailDeliveryNotFoundError,
  EmailProviderMismatchError,
  EmailTemplateNotFoundError,
  renderEmailTemplate,
} from './email.js';
export {
  createMockSmsProvider,
  createSmsProvider,
  deterministicMockSmsOutcome,
  MockSmsProviderError,
} from './sms-provider.js';
export type {
  MockSmsLogEvent,
  MockSmsLogger,
  MockSmsOutcome,
  SmsMessage,
  SmsProvider,
  SmsSendResult,
} from './sms-provider.js';
export {
  createSmsDeliveryHandler,
  createSmsWorker,
  renderSmsTemplate,
  SmsDeliveryError,
  SmsDeliveryNotFoundError,
  SmsProviderMismatchError,
  SmsRecipientMissingError,
  SmsTemplateNotFoundError,
} from './sms.js';
export {
  ClassifiedDeliveryError,
  classifyDeliveryError,
  ProviderDeliveryError,
} from './execution-error.js';
export { recordDeliveryFailure, runClassifiedDelivery } from './retry.js';
export type { DeliveryFailureOutcome } from './retry.js';
export type {
  HandleSmsDeliveryOptions,
  RenderSmsTemplateInput,
  SmsDeliveryHandler,
  SmsTemplateWarning,
  SmsWorker,
} from './sms.js';
export type {
  EmailDeliveryHandler,
  EmailTemplateField,
  EmailTemplateWarning,
  EmailWorker,
  HandleEmailDeliveryOptions,
  RenderedEmailTemplate,
  RenderEmailTemplateInput,
} from './email.js';
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
