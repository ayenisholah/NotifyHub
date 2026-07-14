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
  return { host, port: 4100, apiBaseUrl, userId, apiKey };
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

export function createDemoServer(config: DemoConfig, clientDirectory?: string): HttpServer {
  const app = express();
  app.disable('x-powered-by');

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
