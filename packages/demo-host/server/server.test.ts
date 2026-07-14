// @vitest-environment node
import { createServer as createHttpServer, type RequestListener, type Server } from 'node:http';

import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDemoServer, loadDemoConfig, type DemoConfig } from './server.js';

const servers: Server[] = [];

async function upstream(handler: RequestListener): Promise<{ server: Server; url: URL }> {
  const server = createHttpServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Missing test address');
  return { server, url: new URL(`http://127.0.0.1:${address.port}`) };
}

function config(apiBaseUrl: URL): DemoConfig {
  return {
    host: '127.0.0.1',
    port: 4100,
    apiBaseUrl,
    userId: 'demo-user',
    apiKey: 'server-secret',
    allowedOrigins: ['https://notifyhub.example.test'],
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe('demo host server', () => {
  it('validates the fixed deployment configuration', () => {
    expect(
      loadDemoConfig({
        DEMO_PORT: '4100',
        DEMO_HOST: '0.0.0.0',
        DEMO_API_BASE_URL: 'http://api:4101',
        DEMO_USER_ID: 'demo',
        API_KEY: 'secret',
        WS_ALLOWED_ORIGINS: 'https://notifyhub.example.test',
      }),
    ).toMatchObject({ host: '0.0.0.0', port: 4100, userId: 'demo', apiKey: 'secret' });
    expect(() =>
      loadDemoConfig({
        DEMO_PORT: '3001',
        DEMO_API_BASE_URL: 'http://127.0.0.1:4101',
        DEMO_USER_ID: 'demo',
        API_KEY: 'secret',
        WS_ALLOWED_ORIGINS: 'https://notifyhub.example.test',
      }),
    ).toThrow('DEMO_PORT');

    for (const apiBaseUrl of [
      'ftp://api:4101',
      'http://user:password@api:4101',
      'http://api:4101/private',
      'http://api:4101?secret=value',
    ]) {
      expect(() =>
        loadDemoConfig({
          DEMO_PORT: '4100',
          DEMO_API_BASE_URL: apiBaseUrl,
          DEMO_USER_ID: 'demo',
          API_KEY: 'secret',
          WS_ALLOWED_ORIGINS: 'https://notifyhub.example.test',
        }),
      ).toThrow('DEMO_API_BASE_URL');
    }

    expect(() =>
      loadDemoConfig({
        DEMO_HOST: 'api',
        DEMO_PORT: '4100',
        DEMO_API_BASE_URL: 'http://api:4101',
        DEMO_USER_ID: 'demo',
        API_KEY: 'secret',
        WS_ALLOWED_ORIGINS: 'https://notifyhub.example.test',
      }),
    ).toThrow('DEMO_HOST');
  });

  it('mints a token server-side and forbids caching', async () => {
    const seen: { authorization: string | undefined; url: string | undefined } = {
      authorization: undefined,
      url: undefined,
    };
    const api = await upstream((req, res) => {
      seen.authorization = req.headers.authorization;
      seen.url = req.url;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ token: 'signed-token', expiresAt: 'future' }));
    });
    const demo = createDemoServer(config(api.url), 'missing-test-bundle');
    servers.push(demo);
    const response = await request(demo).get('/demo/token').expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.token).toBe('signed-token');
    expect(seen).toEqual({
      authorization: 'Bearer server-secret',
      url: '/v1/users/demo-user/token',
    });
  });

  it('sanitizes token failures without leaking credentials', async () => {
    const api = await upstream((_req, res) => {
      res.statusCode = 500;
      res.end('database details');
    });
    const demo = createDemoServer(config(api.url), 'missing-test-bundle');
    servers.push(demo);
    const response = await request(demo).get('/demo/token').expect(502);
    expect(JSON.stringify(response.body)).not.toContain('server-secret');
    expect(JSON.stringify(response.body)).not.toContain('database details');
  });

  it('proxies inbox REST traffic with the user authorization intact', async () => {
    const api = await upstream((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ url: req.url, authorization: req.headers.authorization }));
    });
    const demo = createDemoServer(config(api.url), 'missing-test-bundle');
    servers.push(demo);
    const response = await request(demo)
      .get('/v1/inbox?limit=5')
      .set('Authorization', 'Bearer user-token')
      .expect(200);
    expect(response.body).toEqual({ url: '/v1/inbox?limit=5', authorization: 'Bearer user-token' });
  });

  it('submits only the fixed synthetic event with server-side authorization', async () => {
    let body: Record<string, unknown> | undefined;
    let authorization: string | undefined;
    const api = await upstream((req, res) => {
      authorization = req.headers.authorization;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
        res.setHeader('content-type', 'application/json');
        res.statusCode = 202;
        res.end(JSON.stringify({ notificationId: 'notification-1' }));
      });
    });
    const demo = createDemoServer(config(api.url), 'missing-test-bundle');
    servers.push(demo);
    const response = await request(demo)
      .post('/demo/notify')
      .set('Origin', 'https://notifyhub.example.test')
      .send({ userId: 'attacker', payload: { secret: true } })
      .expect(202);
    expect(response.body).toEqual({ notificationId: 'notification-1' });
    expect(authorization).toBe('Bearer server-secret');
    expect(body).toMatchObject({
      userId: 'demo-user',
      event: 'project.updated',
      payload: { actor: 'Nina Kim', projectName: 'Website refresh' },
    });
    expect(body?.idempotencyKey).toMatch(/^public-demo-[0-9a-f-]+$/u);
  });

  it('rejects foreign origins and rate limits each client', async () => {
    const api = await upstream((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.statusCode = 202;
      res.end(JSON.stringify({ notificationId: 'notification-1' }));
    });
    const demo = createDemoServer(config(api.url), 'missing-test-bundle');
    servers.push(demo);
    await request(demo).post('/demo/notify').set('Origin', 'https://foreign.test').expect(403);
    for (let index = 0; index < 3; index += 1) {
      await request(demo)
        .post('/demo/notify')
        .set('Origin', 'https://notifyhub.example.test')
        .expect(202);
    }
    const limited = await request(demo)
      .post('/demo/notify')
      .set('Origin', 'https://notifyhub.example.test')
      .expect(429);
    expect(limited.headers['retry-after']).toBe('60');
    expect(limited.body.error.code).toBe('demo_rate_limited');
  });

  it('sanitizes notification submission failures', async () => {
    const api = await upstream((_req, res) => {
      res.statusCode = 500;
      res.end('database details');
    });
    const demo = createDemoServer(config(api.url), 'missing-test-bundle');
    servers.push(demo);
    const response = await request(demo)
      .post('/demo/notify')
      .set('Origin', 'https://notifyhub.example.test')
      .expect(502);
    expect(JSON.stringify(response.body)).not.toContain('server-secret');
    expect(JSON.stringify(response.body)).not.toContain('database details');
  });
});
