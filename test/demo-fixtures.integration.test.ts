import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Channel, createPrismaClient, type PrismaClient } from '../packages/core/src/index.js';
import { DEMO_EVENT, seedDemoFixtures } from '../packages/runtime/src/demo-fixtures.js';

const executeFile = promisify(execFile);
const prismaExecutable =
  process.platform === 'win32' ? 'node_modules/.bin/prisma.cmd' : 'node_modules/.bin/prisma';

let container: StartedPostgreSqlContainer;
let prisma: PrismaClient;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  const databaseUrl = container.getConnectionUri();
  await executeFile(prismaExecutable, ['migrate', 'deploy'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  prisma = createPrismaClient(databaseUrl);
  await prisma.$connect();
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await container?.stop();
});

describe.sequential('demo fixtures', () => {
  it('are idempotent and preserve existing notification history', async () => {
    await seedDemoFixtures(prisma, 'notifyhub-demo');
    const notification = await prisma.notification.create({
      data: { userId: 'notifyhub-demo', event: DEMO_EVENT, payload: { baseline: true } },
    });
    await seedDemoFixtures(prisma, 'notifyhub-demo');

    await expect(prisma.user.count({ where: { id: 'notifyhub-demo' } })).resolves.toBe(1);
    const templates = await prisma.template.findMany({
      where: { event: DEMO_EVENT, locale: 'en' },
    });
    expect(templates).toHaveLength(3);
    expect(new Set(templates.map(({ channel }) => channel))).toEqual(
      new Set(Object.values(Channel)),
    );
    await expect(
      prisma.notification.findUnique({ where: { id: notification.id } }),
    ).resolves.not.toBeNull();
  });
});
