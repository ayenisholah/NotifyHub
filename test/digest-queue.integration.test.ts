import { Queue } from 'bullmq';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDigestQueueProducer,
  DIGEST_JOB_NAME,
  DIGEST_QUEUE_NAME,
  type DigestJobData,
} from '../packages/core/src/index.js';

let redis: StartedTestContainer;
beforeAll(async () => {
  redis = await new GenericContainer('redis:8-alpine').withExposedPorts(6379).start();
}, 120_000);
afterAll(async () => redis?.stop());

describe('digest flush queue producer', () => {
  it('creates one stable delayed five-attempt job for repeated batch joins', async () => {
    const redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
    const producer = createDigestQueueProducer(redisUrl);
    const queue = new Queue<DigestJobData>(DIGEST_QUEUE_NAME, {
      connection: { host: redis.getHost(), port: redis.getMappedPort(6379) },
    });
    const batchId = '3fdb2e8c-3bf1-45bf-af46-ac120852116f';
    const windowEndsAt = new Date(Date.now() + 60_000);
    try {
      await Promise.all(Array.from({ length: 10 }, () => producer.enqueue(batchId, windowEndsAt)));
      const job = await queue.getJob(batchId);
      expect(job).toMatchObject({
        id: batchId,
        name: DIGEST_JOB_NAME,
        data: { batchId },
        opts: {
          attempts: 5,
          backoff: { type: 'notifyhub-exponential-jitter', delay: 1_000 },
        },
      });
      expect(job!.delay).toBeGreaterThan(55_000);
      expect(await queue.getDelayedCount()).toBe(1);
    } finally {
      await producer.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });
});
