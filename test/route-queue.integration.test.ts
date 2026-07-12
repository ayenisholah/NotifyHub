import { Queue } from 'bullmq';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createRouteQueueProducer,
  ROUTE_JOB_NAME,
  ROUTE_QUEUE_NAME,
  type RouteJobData,
} from '../packages/core/src/index.js';

let redis: StartedTestContainer;

beforeAll(async () => {
  redis = await new GenericContainer('redis:8-alpine').withExposedPorts(6379).start();
}, 120_000);

afterAll(async () => {
  await redis?.stop();
});

describe('BullMQ route producer', () => {
  it('creates a stable route job without requiring a worker', async () => {
    const redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
    const notificationId = '2fdb2e8c-3bf1-45bf-af46-ac120852116f';
    const producer = createRouteQueueProducer(redisUrl);
    const inspector = new Queue<RouteJobData>(ROUTE_QUEUE_NAME, {
      connection: { host: redis.getHost(), port: redis.getMappedPort(6379) },
    });

    try {
      await producer.enqueue(notificationId);
      const job = await inspector.getJob(notificationId);

      expect(job).not.toBeNull();
      expect(job?.name).toBe(ROUTE_JOB_NAME);
      expect(job?.id).toBe(notificationId);
      expect(job?.data).toEqual({ notificationId });
      expect(await inspector.getWaitingCount()).toBe(1);
    } finally {
      await producer.close();
      await inspector.obliterate({ force: true });
      await inspector.close();
    }
  });
});
