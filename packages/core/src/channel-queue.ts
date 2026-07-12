import { Queue } from 'bullmq';

import { Channel } from './generated/prisma/client.js';
import { createRedisConnection } from './route-queue.js';

export const CHANNEL_QUEUE_NAMES = {
  [Channel.EMAIL]: 'send-email',
  [Channel.SMS]: 'send-sms',
  [Channel.IN_APP]: 'send-inapp',
} as const;
export const CHANNEL_JOB_NAME = 'send-delivery';

export interface ChannelJobData {
  deliveryId: string;
}

export interface ChannelJobEnqueuer {
  enqueue(channel: Channel, deliveryId: string): Promise<void>;
}

export interface ChannelQueueProducer extends ChannelJobEnqueuer {
  close(): Promise<void>;
}

export function createChannelQueueProducer(redisUrl: string): ChannelQueueProducer {
  const connection = createRedisConnection(redisUrl);
  const queues = new Map(
    Object.values(Channel).map((channel) => [
      channel,
      new Queue<ChannelJobData>(CHANNEL_QUEUE_NAMES[channel], { connection }),
    ]),
  );

  return {
    async enqueue(channel, deliveryId) {
      const queue = queues.get(channel);
      if (queue === undefined) throw new Error(`Unsupported channel: ${channel}`);
      await queue.add(CHANNEL_JOB_NAME, { deliveryId }, { jobId: deliveryId });
    },
    async close() {
      await Promise.all([...queues.values()].map(async (queue) => queue.close()));
    },
  };
}
