import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type Server as HttpServer } from 'node:http';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express, { type Request, type Response } from 'express';
import { WebSocket, WebSocketServer } from 'ws';

export interface DemoConfig {
  host: '127.0.0.1' | '0.0.0.0';
  port: 4100;
  apiBaseUrl: URL;
  userId: string;
  apiKey: string;
  allowedOrigins: readonly string[];
}

const DEMO_EVENT = 'project.updated';
const clientWindowMs = 60_000;
const clientLimit = 3;
const globalWindowMs = 60 * 60_000;
const globalLimit = 30;

interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

interface RateWindow {
  startedAt: number;
  count: number;
}

export function createDemoRateLimiter(
  now: () => number = Date.now,
): (key: string) => RateLimitResult {
  const clients = new Map<string, RateWindow>();
  let global: RateWindow = { startedAt: now(), count: 0 };

  return (key) => {
    const timestamp = now();
    if (timestamp - global.startedAt >= globalWindowMs) global = { startedAt: timestamp, count: 0 };
    const previous = clients.get(key);
    const client =
      previous === undefined || timestamp - previous.startedAt >= clientWindowMs
        ? { startedAt: timestamp, count: 0 }
        : previous;
    clients.set(key, client);

    const clientRetry = Math.max(
      1,
      Math.ceil((clientWindowMs - (timestamp - client.startedAt)) / 1000),
    );
    const globalRetry = Math.max(
      1,
      Math.ceil((globalWindowMs - (timestamp - global.startedAt)) / 1000),
    );
    if (client.count >= clientLimit) return { allowed: false, retryAfterSeconds: clientRetry };
    if (global.count >= globalLimit) return { allowed: false, retryAfterSeconds: globalRetry };

    client.count += 1;
    global.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  };
}

export function loadDemoConfig(environment: NodeJS.ProcessEnv = process.env): DemoConfig {
  const host = environment.DEMO_HOST ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '0.0.0.0')
    throw new Error('DEMO_HOST must be 127.0.0.1 or 0.0.0.0');
  if (environment.DEMO_PORT !== '4100') throw new Error('DEMO_PORT must be 4100');
  let apiBaseUrl: URL;
  try {
    apiBaseUrl = new URL(environment.DEMO_API_BASE_URL ?? '');
  } catch {
    throw new Error('DEMO_API_BASE_URL must be an absolute HTTP(S) origin');
  }
  if (
    !['http:', 'https:'].includes(apiBaseUrl.protocol) ||
    apiBaseUrl.username !== '' ||
    apiBaseUrl.password !== '' ||
    apiBaseUrl.pathname !== '/' ||
    apiBaseUrl.search !== '' ||
    apiBaseUrl.hash !== ''
  ) {
    throw new Error('DEMO_API_BASE_URL must be a credential-free HTTP(S) origin');
  }
  const userId = environment.DEMO_USER_ID?.trim();
  if (!userId || userId.length > 128) throw new Error('DEMO_USER_ID must be 1-128 characters');
  const apiKey = environment.API_KEY?.trim();
  if (!apiKey) throw new Error('API_KEY is required');
  const allowedOrigins = (environment.WS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (allowedOrigins.length === 0) throw new Error('WS_ALLOWED_ORIGINS must allow the demo origin');
  for (const origin of allowedOrigins) {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin)
      throw new Error('WS_ALLOWED_ORIGINS must contain exact HTTP(S) origins');
  }
  return { host, port: 4100, apiBaseUrl, userId, apiKey, allowedOrigins };
}

function upstreamRequest(config: DemoConfig, request: Request, response: Response): void {
  const target = new URL(request.originalUrl, config.apiBaseUrl);
  const headers = { ...request.headers, host: target.host };
  delete headers['content-length'];
  const upstream = httpRequest(target, { method: request.method, headers }, (result) => {
    response.status(result.statusCode ?? 502);
    for (const [name, value] of Object.entries(result.headers)) {
      if (value !== undefined && name !== 'connection' && name !== 'transfer-encoding')
        response.setHeader(name, value);
    }
    result.pipe(response);
  });
  upstream.on('error', () => {
    if (!response.headersSent)
      response.status(502).json({
        error: { code: 'upstream_unavailable', message: 'Notification service unavailable' },
      });
    else response.end();
  });
  request.pipe(upstream);
}

export function createDemoServer(
  config: DemoConfig,
  clientDirectory?: string,
  options: { now?: () => number } = {},
): HttpServer {
  const app = express();
  app.disable('x-powered-by');
  // The host binds this service to loopback, so production traffic has exactly one Nginx hop.
  app.set('trust proxy', 1);
  const takeRateLimit = createDemoRateLimiter(options.now);

  app.get('/demo/token', async (_request, response) => {
    try {
      const target = new URL(
        `/v1/users/${encodeURIComponent(config.userId)}/token`,
        config.apiBaseUrl,
      );
      const result = await fetch(target, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}` },
      });
      if (!result.ok) throw new Error(`Token upstream returned ${result.status}`);
      const payload: unknown = await result.json();
      if (
        typeof payload !== 'object' ||
        payload === null ||
        !('token' in payload) ||
        typeof payload.token !== 'string'
      )
        throw new Error('Invalid token payload');
      response.set('Cache-Control', 'no-store').json(payload);
    } catch {
      response
        .set('Cache-Control', 'no-store')
        .status(502)
        .json({
          error: {
            code: 'token_unavailable',
            message: 'Notifications are temporarily unavailable',
          },
        });
    }
  });
  app.post('/demo/notify', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    const origin = request.get('origin');
    if (origin === undefined || !config.allowedOrigins.includes(origin)) {
      response.status(403).json({
        error: { code: 'origin_forbidden', message: 'Demo requests must come from this site' },
      });
      return;
    }
    const rateLimit = takeRateLimit(request.ip ?? request.socket.remoteAddress ?? 'unknown');
    if (!rateLimit.allowed) {
      response
        .set('Retry-After', String(rateLimit.retryAfterSeconds))
        .status(429)
        .json({
          error: {
            code: 'demo_rate_limited',
            message: 'Please wait before sending another update',
          },
        });
      return;
    }
    try {
      const result = await fetch(new URL('/v1/notify', config.apiBaseUrl), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId: config.userId,
          event: DEMO_EVENT,
          payload: {
            actor: 'Nina Kim',
            projectName: 'Website refresh',
            summary: 'completed “Finalize homepage copy”',
          },
          idempotencyKey: `public-demo-${randomUUID()}`,
        }),
      });
      if (![200, 202].includes(result.status))
        throw new Error(`Notify upstream returned ${result.status}`);
      const payload: unknown = await result.json();
      if (
        typeof payload !== 'object' ||
        payload === null ||
        !('notificationId' in payload) ||
        typeof payload.notificationId !== 'string'
      )
        throw new Error('Invalid notify payload');
      response.status(202).json({ notificationId: payload.notificationId });
    } catch {
      response.status(502).json({
        error: { code: 'notification_unavailable', message: 'Could not send the demo update' },
      });
    }
  });
  app.use('/v1/inbox', (request, response) => upstreamRequest(config, request, response));

  const staticDirectory =
    clientDirectory ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist-client');
  app.use(express.static(staticDirectory, { index: false, maxAge: '1h', immutable: true }));
  app.get(/.*/, async (request, response, next) => {
    if (!request.accepts('html')) {
      next();
      return;
    }
    const index = path.join(staticDirectory, 'index.html');
    try {
      await access(index);
      response.set('Cache-Control', 'no-store').sendFile(index);
    } catch {
      response.status(503).send('Demo bundle is unavailable.');
    }
  });

  const server = createServer(app);
  const clients = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    if (new URL(request.url ?? '/', 'http://localhost').pathname !== '/ws/inbox') {
      socket.destroy();
      return;
    }
    clients.handleUpgrade(request, socket, head, (client) => {
      const target = new URL(request.url ?? '/ws/inbox', config.apiBaseUrl);
      target.protocol = 'ws:';
      const upstream = new WebSocket(target);
      const pending: Array<Parameters<WebSocket['send']>[0]> = [];
      client.on('message', (data) =>
        upstream.readyState === WebSocket.OPEN ? upstream.send(data) : pending.push(data),
      );
      upstream.on('open', () => {
        for (const data of pending) upstream.send(data);
        pending.length = 0;
      });
      upstream.on('message', (data) => {
        if (client.readyState === WebSocket.OPEN) client.send(data);
      });
      upstream.on('close', (code, reason) => client.close(code, reason.toString()));
      upstream.on('error', () => client.close(1011, 'Notification service unavailable'));
      client.on('close', () => upstream.close());
      client.on('error', () => upstream.close());
    });
  });
  return server;
}

async function start(): Promise<void> {
  const config = loadDemoConfig();
  const server = createDemoServer(config);
  server.listen(config.port, config.host, () =>
    console.log(`Acme Projects listening on http://${config.host}:${config.port}`),
  );
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  void start();
