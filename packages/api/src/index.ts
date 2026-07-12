import { createHash, timingSafeEqual } from 'node:crypto';

import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { z } from 'zod';

import {
  NotificationStatus,
  packageIdentity as corePackage,
  type Prisma,
  type PrismaClient,
} from '@notifyhub/core';

import {
  DlqNotFoundError,
  DlqRetryConflictError,
  type ListDlqHandler,
  type RetryDlqHandler,
} from './dlq.js';

export {
  createPersistentDlqHandlers,
  decodeDlqCursor,
  DlqNotFoundError,
  DlqRetryConflictError,
  encodeDlqCursor,
} from './dlq.js';
export type { DlqListItem, DlqListResult, ListDlqHandler, RetryDlqHandler } from './dlq.js';

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
  dlq?: { operatorKey: string; list: ListDlqHandler; retry: RetryDlqHandler };
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

  app.use(errorHandler);
  return app;
}
