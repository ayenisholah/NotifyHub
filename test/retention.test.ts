import { describe, expect, it, vi } from 'vitest';

import {
  parseRetentionDays,
  runRetention,
  type RetentionJob,
  type RetentionQueue,
} from '../packages/runtime/src/retention.js';

function queue(
  name: string,
  paused: boolean,
  jobs: readonly RetentionJob[] = [],
): RetentionQueue & {
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  clean: ReturnType<typeof vi.fn>;
} {
  return {
    name,
    isPaused: vi.fn(async () => paused),
    pause: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    getActiveCount: vi.fn(async () => 0),
    clean: vi.fn(async () => []),
    getJobs: vi.fn(async () => jobs),
    close: vi.fn(async () => undefined),
  };
}

describe('production retention', () => {
  it('uses seven days by default and rejects unsafe retention windows', () => {
    expect(parseRetentionDays(undefined)).toBe(7);
    expect(parseRetentionDays('14')).toBe(14);
    for (const value of ['0', '1.5', '366', 'not-a-number']) {
      expect(() => parseRetentionDays(value)).toThrow('DEMO_DATA_RETENTION_DAYS');
    }
  });

  it('removes only DLQ jobs strictly older than the boundary', async () => {
    const removeOld = vi.fn(async () => undefined);
    const removeBoundary = vi.fn(async () => undefined);
    const now = new Date('2026-07-14T12:00:00.000Z');
    const sevenDays = 7 * 24 * 60 * 60 * 1_000;
    const dlq = queue('dlq', false, [
      { timestamp: now.getTime() - sevenDays - 1, remove: removeOld },
      { timestamp: now.getTime() - sevenDays, remove: removeBoundary },
    ]);
    const prune = vi.fn(async () => ({ notifications: 3, digestBatches: 1 }));

    const result = await runRetention({
      queues: [dlq],
      store: { prune },
      days: 7,
      now,
    });

    expect(removeOld).toHaveBeenCalledOnce();
    expect(removeBoundary).not.toHaveBeenCalled();
    expect(prune).toHaveBeenCalledWith(new Date('2026-07-07T12:00:00.000Z'));
    expect(result).toEqual({
      cutoff: '2026-07-07T12:00:00.000Z',
      notifications: 3,
      digestBatches: 1,
      queueJobs: 1,
    });
  });

  it('restores each queue to its prior pause state even when pruning fails', async () => {
    const running = queue('notification-route', false);
    const alreadyPaused = queue('send-email', true);

    await expect(
      runRetention({
        queues: [running, alreadyPaused],
        store: { prune: vi.fn(async () => Promise.reject(new Error('database unavailable'))) },
        days: 7,
      }),
    ).rejects.toThrow('database unavailable');

    expect(running.pause).toHaveBeenCalledOnce();
    expect(running.resume).toHaveBeenCalledOnce();
    expect(alreadyPaused.pause).not.toHaveBeenCalled();
    expect(alreadyPaused.resume).not.toHaveBeenCalled();
  });
});
