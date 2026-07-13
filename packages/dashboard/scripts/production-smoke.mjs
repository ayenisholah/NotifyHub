import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

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
if (!index.includes('NotifyHub operator dashboard') || !index.includes('/dashboard/assets/'))
  throw new Error('Dashboard production HTML does not use the expected /dashboard asset base.');

const bundleFiles = await filesBelow(dist);
if (!bundleFiles.some((file) => /assets[/\\].+\.js$/u.test(file.pathname)))
  throw new Error('Dashboard production JavaScript asset is missing.');

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
  'Dashboard production smoke check passed; assets use /dashboard and contain no key, recipient, raw-error, or server-credential markers.',
);
