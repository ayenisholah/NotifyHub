import { createServer } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { createDemoServer } from '../dist-server/server.js';
import { assertPublicMetadata, pngDimensions } from '../../../scripts/verify-public-metadata.mjs';

const canonical = 'https://notifyhub.sholaayeni.xyz/';
const description =
  "Explore NotifyHub's multi-channel notification flow in a live demo spanning in-app inbox, email, SMS, retries, and delivery observability.";
const robots = 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1';

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    if (entry.isDirectory()) files.push(...(await filesBelow(child)));
    else files.push(child);
  }
  return files;
}

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
  if (!page.ok) throw new Error('Demo page smoke check failed');
  assertPublicMetadata(await page.text(), {
    label: 'Demo',
    title: 'NotifyHub Demo — Multi-channel notifications in action',
    canonical,
    description,
    robots,
    themeColor: '#f6f7fb',
    image: `${canonical}social-demo.png`,
    structuredType: 'SoftwareApplication',
    structuredName: 'NotifyHub',
    validateStructuredData(data) {
      if (
        data.applicationCategory !== 'DeveloperApplication' ||
        data.programmingLanguage !== 'TypeScript' ||
        data.license !== 'https://opensource.org/licenses/MIT' ||
        data.codeRepository !== 'https://github.com/ayenisholah/NotifyHub' ||
        data.author?.name !== 'Shola Ayeni' ||
        data.offers?.price !== '0' ||
        data.offers?.priceCurrency !== 'USD'
      ) {
        throw new Error('Demo SoftwareApplication JSON-LD is incomplete or invalid.');
      }
    },
  });
  const token = await fetch(`${base}/demo/token`);
  if (!token.ok || (await token.json()).token !== 'smoke-widget-token')
    throw new Error('Token bootstrap smoke check failed');

  const dist = new URL('../dist-client/', import.meta.url);
  const dimensions = new Map([
    ['social-demo.png', { width: 1200, height: 630 }],
    ['favicon-16x16.png', { width: 16, height: 16 }],
    ['favicon-32x32.png', { width: 32, height: 32 }],
    ['apple-touch-icon.png', { width: 180, height: 180 }],
    ['icon-192x192.png', { width: 192, height: 192 }],
    ['icon-512x512.png', { width: 512, height: 512 }],
  ]);
  for (const [filename, expected] of dimensions) {
    const contents = await readFile(new URL(filename, dist));
    const actual = pngDimensions(contents);
    if (actual.width !== expected.width || actual.height !== expected.height) {
      throw new Error(`${filename} has dimensions ${actual.width}x${actual.height}.`);
    }
  }

  const manifest = JSON.parse(await readFile(new URL('site.webmanifest', dist), 'utf8'));
  if (
    manifest.name !== 'NotifyHub' ||
    manifest.start_url !== '/' ||
    manifest.scope !== '/' ||
    manifest.icons?.[0]?.src !== '/icon-192x192.png' ||
    manifest.icons?.[1]?.src !== '/icon-512x512.png'
  ) {
    throw new Error('The NotifyHub web manifest is invalid.');
  }
  const robotsFile = await readFile(new URL('robots.txt', dist), 'utf8');
  if (!robotsFile.includes('Allow: /') || !robotsFile.includes(`${canonical}sitemap.xml`)) {
    throw new Error('robots.txt does not expose the expected sitemap.');
  }
  const sitemap = await readFile(new URL('sitemap.xml', dist), 'utf8');
  const locations = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/gu)].map((match) => match[1]);
  if (JSON.stringify(locations) !== JSON.stringify([canonical, `${canonical}dashboard`])) {
    throw new Error('sitemap.xml does not contain exactly the two public canonical URLs.');
  }
  await readFile(new URL('favicon.svg', dist), 'utf8');

  const forbidden = [
    secret,
    'API_KEY',
    'OPERATOR_KEY',
    'DATABASE_URL',
    'REDIS_URL',
    'postgresql://',
    'smoke-recipient-private@example.invalid',
    '+15550001111',
    'SMTP 451 raw provider response',
  ];
  for (const file of await filesBelow(dist)) {
    const contents = await readFile(file);
    const leaked = forbidden.find((marker) => contents.includes(Buffer.from(marker)));
    if (leaked !== undefined)
      throw new Error(
        `Sensitive marker ${JSON.stringify(leaked)} leaked into ${path.basename(file.pathname)}.`,
      );
  }
} finally {
  await close(demo);
  await close(upstream);
}

console.log(
  'Production demo smoke check passed; metadata, crawler files, image dimensions, and public asset privacy are valid.',
);
