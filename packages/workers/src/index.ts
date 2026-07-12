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

export const packageIdentity = '@notifyhub/workers' as const;
export const dependencies = [corePackage] as const;
