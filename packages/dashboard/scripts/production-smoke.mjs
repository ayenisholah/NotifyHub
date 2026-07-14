import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { assertPublicMetadata, pngDimensions } from '../../../scripts/verify-public-metadata.mjs';

const canonical = 'https://notifyhub.sholaayeni.xyz/dashboard';
const description =
  'Observe NotifyHub notification delivery in real time across channels, statuses, retry timelines, and the dead-letter queue.';
const robots = 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1';

const dist = new URL('../dist/', import.meta.url);
const indexUrl = new URL('index.html', dist);

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

try {
  await stat(indexUrl);
} catch {
  throw new Error('Dashboard production bundle is missing. Run the dashboard build first.');
}

const index = await readFile(indexUrl, 'utf8');
if (!index.includes('/dashboard/assets/'))
  throw new Error('Dashboard production HTML does not use the expected /dashboard asset base.');
assertPublicMetadata(index, {
  label: 'Dashboard',
  title: 'NotifyHub Dashboard — Live notification delivery',
  canonical,
  description,
  robots,
  themeColor: '#0f1216',
  image: `${canonical}/social-dashboard.png`,
  structuredType: 'WebPage',
  structuredName: 'NotifyHub Dashboard',
  validateStructuredData(data) {
    if (
      !data.description?.includes('public observability surface') ||
      data.isPartOf?.name !== 'NotifyHub' ||
      data.isPartOf?.url !== 'https://notifyhub.sholaayeni.xyz/' ||
      data.about?.applicationCategory !== 'DeveloperApplication'
    ) {
      throw new Error('Dashboard WebPage JSON-LD is incomplete or invalid.');
    }
  },
});

const bundleFiles = await filesBelow(dist);
if (!bundleFiles.some((file) => /assets[/\\].+\.js$/u.test(file.pathname)))
  throw new Error('Dashboard production JavaScript asset is missing.');

const socialCard = await readFile(new URL('social-dashboard.png', dist));
const socialDimensions = pngDimensions(socialCard);
if (socialDimensions.width !== 1200 || socialDimensions.height !== 630) {
  throw new Error(
    `Dashboard social card has dimensions ${socialDimensions.width}x${socialDimensions.height}.`,
  );
}

const forbidden = [
  'production-smoke-operator-key-never-bundle',
  'smoke-recipient-private@example.invalid',
  '+15550001111',
  'SMTP 451 raw provider response',
  'postgresql://',
  'redis://',
  'DATABASE_URL',
  'REDIS_URL',
  'NOTIFYHUB_API_KEY',
  'OPERATOR_KEY',
  'DEMO_USER_ID',
  'providerMessageId',
  'lastError',
  'userId',
  '"payload"',
];

for (const file of bundleFiles) {
  const contents = await readFile(file, 'utf8');
  const leaked = forbidden.find((marker) => contents.includes(marker));
  if (leaked !== undefined)
    throw new Error(
      `Sensitive marker ${JSON.stringify(leaked)} leaked into ${path.basename(file.pathname)}.`,
    );
}

console.log(
  'Dashboard production smoke check passed; metadata, social image, asset base, and public asset privacy are valid.',
);
