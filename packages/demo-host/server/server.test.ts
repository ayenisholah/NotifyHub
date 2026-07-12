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
  return { port: 3000, apiBaseUrl, userId: 'demo-user', apiKey: 'server-secret' };
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
        DEMO_PORT: '3000',
        DEMO_API_BASE_URL: 'http://127.0.0.1:4000',
        DEMO_USER_ID: 'demo',
        API_KEY: 'secret',
      }),
    ).toMatchObject({ port: 3000, userId: 'demo', apiKey: 'secret' });
    expect(() =>
      loadDemoConfig({
        DEMO_PORT: '3001',
        DEMO_API_BASE_URL: 'http://127.0.0.1:4000',
        DEMO_USER_ID: 'demo',
        API_KEY: 'secret',
      }),
    ).toThrow('DEMO_PORT');
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
});
