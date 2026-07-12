import { createPrismaClient } from '../../packages/core/dist/index.js';
import process from 'node:process';

import {
  createEmailDeliveryHandler,
  createEmailWorker,
  createMailpitEmailProvider,
} from '../../packages/workers/dist/index.js';

const prisma = createPrismaClient(process.env.DATABASE_URL);
await prisma.$connect();
const base = createMailpitEmailProvider({
  provider: 'mailpit',
  from: 'notifyhub@example.test',
  host: process.env.MAILPIT_HOST,
  port: Number(process.env.MAILPIT_PORT),
});
let held = false;
const provider = {
  name: 'mailpit',
  async send(message) {
    const result = await base.send(message);
    if (process.env.HOLD_AFTER_SEND === '1' && !held) {
      held = true;
      process.send?.({ type: 'sent', deliveryId: message.idempotencyKey });
      await new Promise(() => undefined);
    }
    return result;
  },
};
const worker = createEmailWorker(
  process.env.REDIS_URL,
  createEmailDeliveryHandler(prisma, provider),
  {
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? '1'),
    lockDuration: 2_000,
    stalledInterval: 1_000,
  },
);
process.send?.({ type: 'ready' });

async function close() {
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());
