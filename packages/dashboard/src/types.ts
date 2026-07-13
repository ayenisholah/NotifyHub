export const DELIVERY_STATUSES = [
  'QUEUED',
  'SCHEDULED',
  'PROCESSING',
  'RETRYING',
  'SENT',
  'FAILED',
  'DLQ',
] as const;

export const NOTIFICATION_STATUSES = ['ACCEPTED', 'ROUTED', 'NO_OP'] as const;

export const CHANNELS = ['EMAIL', 'SMS', 'IN_APP'] as const;

export const EVENT_REASONS = [
  'immediate',
  'critical',
  'quiet_hours',
  'digest',
  'no_template',
  'no_templates',
  'preference_disabled',
  'preferences_disabled',
  'digest_flush',
  'email_processing',
  'email_sent',
  'sms_processing',
  'sms_sent',
  'in_app_processing',
  'inbox_persisted',
  'delivery_failure_claimed',
  'delivery_retry_scheduled',
  'delivery_failed',
  'delivery_dead_lettered',
  'operator_retry',
] as const;

export const ERROR_CLASSIFICATIONS = [
  'ClassifiedDeliveryError',
  'ProviderDeliveryError',
  'UnexpectedError',
  'MockSmsProviderError',
  'EmailDeliveryError',
  'EmailDeliveryNotFoundError',
  'EmailProviderMismatchError',
  'EmailTemplateNotFoundError',
  'SmsDeliveryError',
  'SmsDeliveryNotFoundError',
  'SmsProviderMismatchError',
  'SmsRecipientMissingError',
  'SmsTemplateNotFoundError',
] as const;

export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];
export type Channel = (typeof CHANNELS)[number];
export type DashboardEventReason = (typeof EVENT_REASONS)[number];
export type DashboardErrorClassification = (typeof ERROR_CLASSIFICATIONS)[number];

export interface DashboardSummary {
  sentToday: number;
  inFlight: number;
  failed: number;
  dlq: number;
}

export interface DashboardTimelineEvent {
  status: DeliveryStatus;
  createdAt: string;
  reason: DashboardEventReason | null;
  errorClassification: DashboardErrorClassification | null;
}

export interface DashboardDeliveryStatus {
  deliveryId: string;
  channel: Channel;
  status: DeliveryStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardNotificationListItem {
  notificationId: string;
  event: string;
  status: NotificationStatus;
  reason: DashboardEventReason | null;
  createdAt: string;
  deliveries: DashboardDeliveryStatus[];
}

export interface DashboardNotificationListResult {
  items: DashboardNotificationListItem[];
  nextCursor: string | null;
}

export interface DashboardDeliveryDetail extends DashboardDeliveryStatus {
  timeline: DashboardTimelineEvent[];
}

export interface DashboardNotificationDetail {
  notificationId: string;
  event: string;
  status: NotificationStatus;
  reason: DashboardEventReason | null;
  createdAt: string;
  deliveries: DashboardDeliveryDetail[];
}

export interface DashboardDlqItem {
  deliveryId: string;
  notificationId: string;
  event: string;
  channel: Channel;
  status: 'DLQ';
  attempts: number;
  createdAt: string;
  updatedAt: string;
  reason: DashboardEventReason | null;
  errorClassification: DashboardErrorClassification | null;
}

export interface DashboardDlqListResult {
  items: DashboardDlqItem[];
  nextCursor: string | null;
}

export type RetryOutcome = 'retried' | 'unauthorized' | 'removed' | 'ineligible';
