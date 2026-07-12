import { createHash, timingSafeEqual } from 'node:crypto';

import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { z } from 'zod';

import { packageIdentity as corePackage } from '@notifyhub/core';

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
}

export type NotifyHandler = (request: NotifyRequest) => Promise<NotifyResult>;

export interface CreateAppOptions {
  apiKey: string;
  notify: NotifyHandler;
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
      response.status(202).json({ notificationId: result.notificationId });
    },
  );

  app.use(errorHandler);
  return app;
}
