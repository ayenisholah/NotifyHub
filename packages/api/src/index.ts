import { createHash, timingSafeEqual } from 'node:crypto';
import { access } from 'node:fs/promises';
import path from 'node:path';

import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { z } from 'zod';

import {
  Channel,
  DeliveryStatus,
  NotificationStatus,
  packageIdentity as corePackage,
  type Prisma,
  type PrismaClient,
} from '@notifyhub/core';

import {
  DASHBOARD_ERROR_CLASSIFICATIONS,
  DASHBOARD_EVENT_REASONS,
  DashboardNotificationNotFoundError,
  decodeDashboardDlqCursor,
  decodeDashboardNotificationCursor,
  InvalidDashboardDlqCursorError,
  InvalidDashboardNotificationCursorError,
  type DashboardHandlers,
} from './dashboard.js';
import {
  DlqNotFoundError,
  DlqRetryConflictError,
  type ListDlqHandler,
  type RetryDlqHandler,
} from './dlq.js';
import { InboxMessageNotFoundError, UserNotFoundError, type InboxHandlers } from './inbox.js';
import { InvalidUserTokenError, verifyUserToken } from './user-token.js';

export {
  createPersistentDashboardHandlers,
  DASHBOARD_ERROR_CLASSIFICATIONS,
  DASHBOARD_EVENT_REASONS,
  DashboardNotificationNotFoundError,
  decodeDashboardDlqCursor,
  decodeDashboardNotificationCursor,
  encodeDashboardDlqCursor,
  encodeDashboardNotificationCursor,
  InvalidDashboardDlqCursorError,
  InvalidDashboardNotificationCursorError,
} from './dashboard.js';
export type {
  DashboardDeliveryDetail,
  DashboardDeliveryStatus,
  DashboardDlqCursor,
  DashboardDlqItem,
  DashboardDlqListResult,
  DashboardErrorClassification,
  DashboardEventReason,
  DashboardHandlers,
  DashboardNotificationCursor,
  DashboardNotificationDetail,
  DashboardNotificationListItem,
  DashboardNotificationListResult,
  DashboardSummary,
  DashboardTimelineEvent,
  GetDashboardNotificationHandler,
  GetDashboardSummaryHandler,
  ListDashboardDlqHandler,
  ListDashboardNotificationsHandler,
  PersistentDashboardOptions,
} from './dashboard.js';
export {
  createPersistentDlqHandlers,
  decodeDlqCursor,
  DlqNotFoundError,
  DlqRetryConflictError,
  encodeDlqCursor,
} from './dlq.js';
export type { DlqListItem, DlqListResult, ListDlqHandler, RetryDlqHandler } from './dlq.js';
export {
  createPersistentInboxHandlers,
  decodeInboxCursor,
  encodeInboxCursor,
  InboxMessageNotFoundError,
  UserNotFoundError,
} from './inbox.js';
export type {
  CountUnreadInboxHandler,
  InboxCursor,
  InboxHandlers,
  InboxListResult,
  InboxMessage,
  InboxReadAllResult,
  IssueUserTokenHandler,
  ListInboxHandler,
  ReadAllInboxHandler,
  ReadInboxMessageHandler,
} from './inbox.js';
export { createInboxWebSocketGateway } from './websocket-gateway.js';
export type {
  CreateInboxGatewayOptions,
  InboxGateway,
  InboxGatewayClientEvent,
  InboxGatewayDiagnostic,
  InboxGatewayDiagnosticCode,
  InboxGatewayDiagnosticHandler,
  InboxGatewayLifecycle,
  InboxGatewayRooms,
  InboxEventSubscriber,
} from './websocket-gateway.js';
export {
  InvalidUserTokenError,
  issueUserToken,
  USER_TOKEN_LIFETIME_SECONDS,
  verifyUserToken,
} from './user-token.js';
export type {
  IssuedUserToken,
  IssueUserTokenOptions,
  UserTokenClaims,
  VerifyUserTokenOptions,
} from './user-token.js';

export const packageIdentity = '@notifyhub/api' as const;
export const dependencies = [corePackage] as const;

const notifyRequestSchema = z
  .object({
    userId: z.string().min(1).max(128),
    event: z.string().min(1).max(128),
    payload: z.record(z.unknown()),
    idempotencyKey: z.string().min(1).max(255).optional(),
  })
  .strict();

export type NotifyRequest = z.infer<typeof notifyRequestSchema>;

const dashboardEventReasonSchema = z.enum(DASHBOARD_EVENT_REASONS).nullable();
const dashboardErrorClassificationSchema = z.enum(DASHBOARD_ERROR_CLASSIFICATIONS).nullable();
const dashboardTimestampSchema = z.string().datetime();
const dashboardDeliveryStatusSchema = z.object({
  deliveryId: z.string().uuid(),
  channel: z.nativeEnum(Channel),
  status: z.nativeEnum(DeliveryStatus),
  attempts: z.number().int().nonnegative(),
  createdAt: dashboardTimestampSchema,
  updatedAt: dashboardTimestampSchema,
});
const dashboardTimelineEventSchema = z.object({
  status: z.nativeEnum(DeliveryStatus),
  createdAt: dashboardTimestampSchema,
  reason: dashboardEventReasonSchema,
  errorClassification: dashboardErrorClassificationSchema,
});
const dashboardNotificationBaseSchema = z.object({
  notificationId: z.string().uuid(),
  event: z.string().min(1).max(128),
  status: z.nativeEnum(NotificationStatus),
  reason: dashboardEventReasonSchema,
  createdAt: dashboardTimestampSchema,
});
const dashboardNotificationListItemSchema = dashboardNotificationBaseSchema.extend({
  deliveries: z.array(dashboardDeliveryStatusSchema),
});
const dashboardNotificationDetailSchema = dashboardNotificationBaseSchema.extend({
  deliveries: z.array(
    dashboardDeliveryStatusSchema.extend({ timeline: z.array(dashboardTimelineEventSchema) }),
  ),
});
const dashboardSummarySchema = z.object({
  sentToday: z.number().int().nonnegative(),
  inFlight: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  dlq: z.number().int().nonnegative(),
});
const dashboardNotificationCursorResponseSchema = z.string().refine((cursor) => {
  try {
    decodeDashboardNotificationCursor(cursor);
    return true;
  } catch {
    return false;
  }
});
const dashboardDlqCursorResponseSchema = z.string().refine((cursor) => {
  try {
    decodeDashboardDlqCursor(cursor);
    return true;
  } catch {
    return false;
  }
});
const dashboardNotificationListResultSchema = z.object({
  items: z.array(dashboardNotificationListItemSchema),
  nextCursor: dashboardNotificationCursorResponseSchema.nullable(),
});
const dashboardDlqListResultSchema = z.object({
  items: z.array(
    z.object({
      deliveryId: z.string().uuid(),
      notificationId: z.string().uuid(),
      event: z.string().min(1).max(128),
      channel: z.nativeEnum(Channel),
      status: z.literal(DeliveryStatus.DLQ),
      attempts: z.number().int().nonnegative(),
      createdAt: dashboardTimestampSchema,
      updatedAt: dashboardTimestampSchema,
      reason: dashboardEventReasonSchema,
      errorClassification: dashboardErrorClassificationSchema,
    }),
  ),
  nextCursor: dashboardDlqCursorResponseSchema.nullable(),
});

export interface NotifyResult {
  notificationId: string;
  replayed: boolean;
}

export type NotifyHandler = (request: NotifyRequest) => Promise<NotifyResult>;

export interface RouteEnqueuer {
  enqueue(notificationId: string): Promise<void>;
}

function isUniqueConstraintError(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'P2002';
}

export function createPersistentNotifyHandler(
  prisma: PrismaClient,
  routeEnqueuer: RouteEnqueuer,
): NotifyHandler {
  return async (request) => {
    let notification;
    try {
      notification = await prisma.notification.create({
        data: {
          userId: request.userId,
          event: request.event,
          payload: request.payload as Prisma.InputJsonValue,
          status: NotificationStatus.ACCEPTED,
          ...(request.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: request.idempotencyKey }),
        },
      });
    } catch (error) {
      if (request.idempotencyKey === undefined || !isUniqueConstraintError(error)) {
        throw error;
      }

      const original = await prisma.notification.findUniqueOrThrow({
        where: { idempotencyKey: request.idempotencyKey },
      });
      return { notificationId: original.id, replayed: true };
    }

    await routeEnqueuer.enqueue(notification.id);
    return { notificationId: notification.id, replayed: false };
  };
}

export interface CreateAppOptions {
  apiKey: string;
  notify: NotifyHandler;
  dashboard?: DashboardHandlers;
  dashboardAssetsDirectory?: string;
  dlq?: { operatorKey: string; list: ListDlqHandler; retry: RetryDlqHandler };
  inbox?: InboxHandlers & { tokenSecret: string };
}

const unauthorized = {
  error: { code: 'unauthorized', message: 'Valid bearer token required' },
} as const;

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function hasOneAuthorizationHeader(request: Request): boolean {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === 'authorization') {
      count += 1;
    }
  }
  return count === 1;
}

function authenticate(expectedDigest: Buffer) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const submitted = request.get('authorization');
    const valid =
      hasOneAuthorizationHeader(request) &&
      submitted !== undefined &&
      timingSafeEqual(digest(submitted), expectedDigest);

    if (!valid) {
      response.status(401).json(unauthorized);
      return;
    }

    next();
  };
}

function authenticateUser(tokenSecret: string) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const submitted = request.get('authorization');
    if (!hasOneAuthorizationHeader(request) || submitted?.startsWith('Bearer ') !== true) {
      response.status(401).json(unauthorized);
      return;
    }
    try {
      response.locals.userId = verifyUserToken(submitted.slice('Bearer '.length), tokenSecret).sub;
      next();
    } catch (error) {
      if (!(error instanceof InvalidUserTokenError)) throw error;
      response.status(401).json(unauthorized);
    }
  };
}

const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  void _next;

  if (error instanceof SyntaxError && 'type' in error && error.type === 'entity.parse.failed') {
    response.status(400).json({
      error: { code: 'invalid_json', message: 'Request body must be valid JSON' },
    });
    return;
  }

  if (
    error !== null &&
    typeof error === 'object' &&
    'type' in error &&
    error.type === 'entity.too.large'
  ) {
    response.status(413).json({
      error: { code: 'payload_too_large', message: 'Request body exceeds 100 KiB' },
    });
    return;
  }

  response.status(500).json({
    error: { code: 'internal_error', message: 'Internal server error' },
  });
};

export function createApp(options: CreateAppOptions): express.Express {
  const app = express();
  const expectedDigest = digest(`Bearer ${options.apiKey}`);
  const operatorDigest =
    options.dlq === undefined ? undefined : digest(`Bearer ${options.dlq.operatorKey}`);

  app.post(
    '/v1/notify',
    authenticate(expectedDigest),
    express.json({ limit: 100 * 1024, strict: true }),
    async (request, response) => {
      const parsed = notifyRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(422).json({
          error: {
            code: 'validation_error',
            message: 'Request validation failed',
            fields: parsed.error.issues.map((issue) => ({
              path: issue.path.map(String).join('.'),
              message: issue.message,
            })),
          },
        });
        return;
      }

      const result = await options.notify(parsed.data);
      response.status(result.replayed ? 200 : 202).json({ notificationId: result.notificationId });
    },
  );

  if (options.dashboard !== undefined) {
    app.use('/v1/dashboard', (_request, response, next) => {
      response.set('Cache-Control', 'no-store');
      next();
    });

    app.get('/v1/dashboard/summary', async (_request, response) => {
      response.json(dashboardSummarySchema.parse(await options.dashboard!.summary()));
    });

    app.get('/v1/dashboard/notifications', async (request, response) => {
      const parsed = z
        .object({
          limit: z.coerce.number().int().min(1).max(100).default(20),
          cursor: z.string().min(1).optional(),
        })
        .strict()
        .safeParse(request.query);
      if (!parsed.success) {
        response.status(422).json({
          error: { code: 'validation_error', message: 'Invalid dashboard notifications query' },
        });
        return;
      }
      try {
        response.json(
          dashboardNotificationListResultSchema.parse(
            await options.dashboard!.listNotifications({
              limit: parsed.data.limit,
              ...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor }),
            }),
          ),
        );
      } catch (error) {
        if (error instanceof InvalidDashboardNotificationCursorError) {
          response.status(422).json({
            error: { code: 'validation_error', message: 'Invalid dashboard notification cursor' },
          });
          return;
        }
        throw error;
      }
    });

    app.get('/v1/dashboard/notifications/:id', async (request, response) => {
      const parsed = z.string().uuid().safeParse(request.params.id);
      if (!parsed.success) {
        response.status(422).json({
          error: { code: 'validation_error', message: 'Invalid dashboard notification ID' },
        });
        return;
      }
      try {
        response.json(
          dashboardNotificationDetailSchema.parse(
            await options.dashboard!.getNotification(parsed.data),
          ),
        );
      } catch (error) {
        if (error instanceof DashboardNotificationNotFoundError) {
          response.status(404).json({
            error: { code: 'not_found', message: 'Dashboard notification not found' },
          });
          return;
        }
        throw error;
      }
    });

    app.get('/v1/dashboard/dlq', async (request, response) => {
      const parsed = z
        .object({
          limit: z.coerce.number().int().min(1).max(100).default(20),
          cursor: z.string().min(1).optional(),
        })
        .strict()
        .safeParse(request.query);
      if (!parsed.success) {
        response.status(422).json({
          error: { code: 'validation_error', message: 'Invalid dashboard DLQ query' },
        });
        return;
      }
      try {
        response.json(
          dashboardDlqListResultSchema.parse(
            await options.dashboard!.listDlq({
              limit: parsed.data.limit,
              ...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor }),
            }),
          ),
        );
      } catch (error) {
        if (error instanceof InvalidDashboardDlqCursorError) {
          response.status(422).json({
            error: { code: 'validation_error', message: 'Invalid dashboard DLQ cursor' },
          });
          return;
        }
        throw error;
      }
    });
  }

  if (options.inbox !== undefined) {
    const userAuth = authenticateUser(options.inbox.tokenSecret);

    app.post('/v1/users/:userId/token', authenticate(expectedDigest), async (request, response) => {
      const parsed = z.string().min(1).max(128).safeParse(request.params.userId);
      if (!parsed.success) {
        response
          .status(422)
          .json({ error: { code: 'validation_error', message: 'Invalid user ID' } });
        return;
      }
      try {
        response.json(await options.inbox!.issueToken(parsed.data));
      } catch (error) {
        if (error instanceof UserNotFoundError) {
          response.status(404).json({ error: { code: 'not_found', message: 'User not found' } });
          return;
        }
        throw error;
      }
    });

    app.get('/v1/inbox', userAuth, async (request, response) => {
      const parsed = z
        .object({
          limit: z.coerce.number().int().min(1).max(100).default(20),
          cursor: z.string().min(1).optional(),
        })
        .strict()
        .safeParse(request.query);
      if (!parsed.success) {
        response
          .status(422)
          .json({ error: { code: 'validation_error', message: 'Invalid inbox query' } });
        return;
      }
      try {
        response.json(
          await options.inbox!.list(response.locals.userId as string, {
            limit: parsed.data.limit,
            ...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor }),
          }),
        );
      } catch (error) {
        if (error instanceof Error && error.message === 'Invalid inbox cursor') {
          response
            .status(422)
            .json({ error: { code: 'validation_error', message: 'Invalid inbox cursor' } });
          return;
        }
        throw error;
      }
    });

    app.post('/v1/inbox/read-all', userAuth, async (_request, response) => {
      response.json(await options.inbox!.readAll(response.locals.userId as string));
    });

    app.post('/v1/inbox/:id/read', userAuth, async (request, response) => {
      const parsed = z.string().uuid().safeParse(request.params.id);
      if (!parsed.success) {
        response
          .status(422)
          .json({ error: { code: 'validation_error', message: 'Invalid inbox message ID' } });
        return;
      }
      try {
        response.json(await options.inbox!.read(response.locals.userId as string, parsed.data));
      } catch (error) {
        if (error instanceof InboxMessageNotFoundError) {
          response
            .status(404)
            .json({ error: { code: 'not_found', message: 'Inbox message not found' } });
          return;
        }
        throw error;
      }
    });
  }

  if (options.dlq !== undefined && operatorDigest !== undefined) {
    app.get('/v1/dlq', authenticate(operatorDigest), async (request, response) => {
      const parsed = z
        .object({
          limit: z.coerce.number().int().min(1).max(100).default(50),
          cursor: z.string().min(1).optional(),
        })
        .safeParse(request.query);
      if (!parsed.success) {
        response
          .status(422)
          .json({ error: { code: 'validation_error', message: 'Invalid DLQ query' } });
        return;
      }
      try {
        response.json(
          await options.dlq!.list({
            limit: parsed.data.limit,
            ...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor }),
          }),
        );
      } catch (error) {
        if (error instanceof Error && error.message === 'Invalid DLQ cursor') {
          response
            .status(422)
            .json({ error: { code: 'validation_error', message: 'Invalid DLQ cursor' } });
          return;
        }
        throw error;
      }
    });
    app.post(
      '/v1/dlq/:deliveryId/retry',
      authenticate(operatorDigest),
      async (request, response) => {
        const parsed = z.string().uuid().safeParse(request.params.deliveryId);
        if (!parsed.success) {
          response
            .status(422)
            .json({ error: { code: 'validation_error', message: 'Invalid delivery ID' } });
          return;
        }
        try {
          const result = await options.dlq!.retry(parsed.data);
          response.status(result.replayed ? 200 : 202).json({ deliveryId: parsed.data });
        } catch (error) {
          if (error instanceof DlqNotFoundError) {
            response
              .status(404)
              .json({ error: { code: 'not_found', message: 'DLQ delivery not found' } });
            return;
          }
          if (error instanceof DlqRetryConflictError) {
            response
              .status(409)
              .json({ error: { code: 'conflict', message: 'Delivery is not eligible for retry' } });
            return;
          }
          throw error;
        }
      },
    );
  }

  if (options.dashboardAssetsDirectory !== undefined) {
    const staticDirectory = path.resolve(options.dashboardAssetsDirectory);
    const indexFile = path.join(staticDirectory, 'index.html');
    app.use(
      '/dashboard',
      express.static(staticDirectory, {
        index: false,
        redirect: false,
        maxAge: '1y',
        immutable: true,
        setHeaders(response, fileName) {
          if (path.resolve(fileName) === indexFile) {
            response.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          }
        },
      }),
    );
    app.get(/^\/dashboard(?:\/.*)?$/, async (_request, response, next) => {
      try {
        await access(indexFile);
        response.set('Cache-Control', 'no-cache, no-store, must-revalidate').sendFile(indexFile);
      } catch (error) {
        if (
          error !== null &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          response.status(503).type('text/plain').send('Dashboard bundle is unavailable.');
          return;
        }
        next(error);
      }
    });
  }

  app.use(errorHandler);
  return app;
}
