import { Queue, type ConnectionOptions } from 'bullmq';

export const ROUTE_QUEUE_NAME = 'notification-route';
export const ROUTE_JOB_NAME = 'route-notification';

export interface RouteJobData {
  notificationId: string;
}

export interface RouteQueueProducer {
  enqueue(notificationId: string): Promise<void>;
  close(): Promise<void>;
}

export function createRedisConnection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  const database = url.pathname.slice(1);

  return {
    host: url.hostname,
    port: url.port === '' ? 6379 : Number(url.port),
    ...(url.username === '' ? {} : { username: decodeURIComponent(url.username) }),
    ...(url.password === '' ? {} : { password: decodeURIComponent(url.password) }),
    ...(database === '' ? {} : { db: Number(database) }),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

export function createRouteQueueProducer(redisUrl: string): RouteQueueProducer {
  const queue = new Queue<RouteJobData>(ROUTE_QUEUE_NAME, {
    connection: createRedisConnection(redisUrl),
  });

  return {
    async enqueue(notificationId) {
      await queue.add(ROUTE_JOB_NAME, { notificationId }, { jobId: notificationId });
    },
    async close() {
      await queue.close();
    },
  };
}
