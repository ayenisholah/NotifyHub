import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from './generated/prisma/client.js';

export function createPrismaClient(databaseUrl: string): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5_000,
  });

  return new PrismaClient({ adapter });
}

export type { PrismaClient } from './generated/prisma/client.js';
export {
  Channel,
  DeliveryStatus,
  DigestBatchStatus,
  NotificationStatus,
} from './generated/prisma/client.js';
