import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPersistentInboxHandlers, decodeInboxCursor } from '../packages/api/src/index.js';
import { createPrismaClient, type PrismaClient } from '../packages/core/src/index.js';

const executeFile = promisify(execFile);
const prismaExecutable =
  process.platform === 'win32' ? 'node_modules/.bin/prisma.cmd' : 'node_modules/.bin/prisma';
const tokenSecret = 'integration-user-token-secret-with-enough-entropy';
const readTime = new Date('2026-07-12T13:00:00.000Z');
const ids = [
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
];

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

beforeEach(async () => {
  await prisma.notification.deleteMany();
  await prisma.user.deleteMany();
  await prisma.user.createMany({
    data: [
      { id: 'user-1', email: 'user-1@example.test' },
      { id: 'user-2', email: 'user-2@example.test' },
    ],
  });
  for (let index = 0; index < ids.length; index += 1) {
    const notificationId = `20000000-0000-4000-8000-00000000000${index + 1}`;
    await prisma.notification.create({
      data: {
        id: notificationId,
        userId: 'user-1',
        event: 'test.event',
        payload: {},
        inboxMessage: {
          create: {
            id: ids[index]!,
            userId: 'user-1',
            title: `Message ${index + 1}`,
            body: 'Body',
            createdAt: new Date('2026-07-12T12:00:00.000Z'),
          },
        },
      },
    });
  }
});

afterAll(async () => {
  await prisma?.$disconnect();
  await container?.stop();
});

describe.sequential('persistent inbox handlers', () => {
  it('paginates tied timestamps deterministically and keeps cursors stable across reads', async () => {
    const handlers = createPersistentInboxHandlers(prisma, tokenSecret, () => readTime);
    const first = await handlers.list('user-1', { limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual([ids[2], ids[1]]);
    expect(first.unreadCount).toBe(3);
    expect(decodeInboxCursor(first.nextCursor!).id).toBe(ids[1]);

    await handlers.read('user-1', ids[2]!);
    const second = await handlers.list('user-1', { limit: 2, cursor: first.nextCursor! });
    expect(second.items.map((item) => item.id)).toEqual([ids[0]]);
    expect(second.unreadCount).toBe(2);
  });

  it('preserves the first read timestamp under replay and concurrency', async () => {
    const firstTime = new Date('2026-07-12T13:00:00.000Z');
    const handlers = createPersistentInboxHandlers(prisma, tokenSecret, () => firstTime);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => handlers.read('user-1', ids[0]!)),
    );
    expect(new Set(results.map((result) => result.readAt))).toEqual(
      new Set([firstTime.toISOString()]),
    );
    const replay = await createPersistentInboxHandlers(
      prisma,
      tokenSecret,
      () => new Date('2026-07-12T14:00:00.000Z'),
    ).read('user-1', ids[0]!);
    expect(replay.readAt).toBe(firstTime.toISOString());
  });

  it('marks all caller-owned unread messages and isolates tenants', async () => {
    const handlers = createPersistentInboxHandlers(prisma, tokenSecret, () => readTime);
    expect(await handlers.countUnread('user-1')).toBe(3);
    expect(await handlers.countUnread('user-2')).toBe(0);
    expect(await handlers.list('user-2', { limit: 20 })).toEqual({
      items: [],
      unreadCount: 0,
      nextCursor: null,
    });
    await expect(handlers.read('user-2', ids[0]!)).rejects.toThrow('Inbox message not found');
    expect(await handlers.readAll('user-2')).toEqual({ updatedCount: 0, unreadCount: 0 });
    expect(await handlers.readAll('user-1')).toEqual({ updatedCount: 3, unreadCount: 0 });
    expect(await handlers.readAll('user-1')).toEqual({ updatedCount: 0, unreadCount: 0 });
  });

  it('issues tokens only for existing users', async () => {
    const handlers = createPersistentInboxHandlers(prisma, tokenSecret, () => readTime);
    await expect(handlers.issueToken('user-1')).resolves.toMatchObject({
      expiresAt: '2026-07-12T13:15:00.000Z',
    });
    await expect(handlers.issueToken('unknown')).rejects.toThrow('User not found');
  });
});
