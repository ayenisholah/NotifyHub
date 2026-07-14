import { createServer } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { createDemoServer } from '../dist-server/server.js';

const secret = 'production-smoke-secret-never-bundle';
const upstream = createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${secret}`) {
    response.statusCode = 401;
    response.end();
    return;
  }
  response.setHeader('content-type', 'application/json');
  response.end(
    JSON.stringify({ token: 'smoke-widget-token', expiresAt: '2099-01-01T00:00:00.000Z' }),
  );
});

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));

await listen(upstream);
const upstreamAddress = upstream.address();
if (upstreamAddress === null || typeof upstreamAddress === 'string')
  throw new Error('Upstream did not start');

const demo = createDemoServer({
  port: 4100,
  apiBaseUrl: new URL(`http://127.0.0.1:${upstreamAddress.port}`),
  userId: 'smoke-user',
  apiKey: secret,
  allowedOrigins: ['http://127.0.0.1'],
});

try {
  await listen(demo);
  const address = demo.address();
  if (address === null || typeof address === 'string') throw new Error('Demo did not start');
  const base = `http://127.0.0.1:${address.port}`;
  const page = await fetch(base);
  if (!page.ok || !(await page.text()).includes('Acme Projects'))
    throw new Error('Demo page smoke check failed');
  const token = await fetch(`${base}/demo/token`);
  if (!token.ok || (await token.json()).token !== 'smoke-widget-token')
    throw new Error('Token bootstrap smoke check failed');

  const assetDirectory = new URL('../dist-client/assets/', import.meta.url);
  for (const filename of await readdir(assetDirectory)) {
    const contents = await readFile(new URL(filename, assetDirectory), 'utf8');
    if (contents.includes(secret) || contents.includes('API_KEY'))
      throw new Error(`Server credential leaked into ${path.basename(filename)}`);
  }
} finally {
  await close(demo);
  await close(upstream);
}

console.log('Production demo smoke check passed; browser assets contain no server credentials.');
