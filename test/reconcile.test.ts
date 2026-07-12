import { describe, expect, it, vi } from 'vitest';

import { Channel, DeliveryStatus, type PrismaClient } from '../packages/core/src/index.js';
import { reconcilePersistedWork } from '../packages/workers/src/index.js';

describe('persisted work reconciliation', () => {
  it('re-enqueues accepted, active, scheduled, and parked work by stable IDs', async () => {
    const scheduledFor = new Date('2026-07-13T08:00:00.000Z');
    const prisma = {
      notification: { findMany: vi.fn(async () => [{ id: 'notification-1' }]) },
      delivery: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: 'queued',
              channel: Channel.EMAIL,
              scheduledFor: null,
              status: DeliveryStatus.QUEUED,
            },
            {
              id: 'scheduled',
              channel: Channel.SMS,
              scheduledFor,
              status: DeliveryStatus.SCHEDULED,
            },
            {
              id: 'processing',
              channel: Channel.EMAIL,
              scheduledFor: null,
              status: DeliveryStatus.PROCESSING,
            },
          ])
          .mockResolvedValueOnce([{ id: 'parked', status: DeliveryStatus.DLQ }]),
      },
    } as unknown as PrismaClient;
    const routeJobs = { enqueue: vi.fn(async () => undefined) };
    const channelJobs = { enqueue: vi.fn(async () => undefined) };
    const dlq = { park: vi.fn(async () => undefined) };

    await expect(
      reconcilePersistedWork(
        prisma,
        { routeJobs, channelJobs, dlq },
        new Date('2026-07-12T12:00:00.000Z'),
      ),
    ).resolves.toEqual({ notifications: 1, deliveries: 3, deadLetters: 1 });
    expect(routeJobs.enqueue).toHaveBeenCalledWith('notification-1');
    expect(channelJobs.enqueue.mock.calls).toEqual([
      [Channel.EMAIL, 'queued', undefined],
      [Channel.SMS, 'scheduled', scheduledFor],
      [Channel.EMAIL, 'processing', undefined],
    ]);
    expect(dlq.park).toHaveBeenCalledWith('parked');
  });

  it('reports an empty idempotent sweep without queue writes', async () => {
    const prisma = {
      notification: { findMany: vi.fn(async () => []) },
      delivery: { findMany: vi.fn(async () => []) },
    } as unknown as PrismaClient;
    const enqueue = vi.fn(async () => undefined);
    const park = vi.fn(async () => undefined);
    await expect(
      reconcilePersistedWork(
        prisma,
        { routeJobs: { enqueue }, channelJobs: { enqueue: vi.fn() }, dlq: { park } },
        new Date(),
      ),
    ).resolves.toEqual({ notifications: 0, deliveries: 0, deadLetters: 0 });
    expect(enqueue).not.toHaveBeenCalled();
    expect(park).not.toHaveBeenCalled();
  });
});
