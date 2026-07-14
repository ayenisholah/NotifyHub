import { createServer } from 'node:http';
import path from 'node:path';

import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

import {
  createApp,
  createInboxWebSocketGateway,
  createPersistentDashboardHandlers,
  createPersistentDlqHandlers,
  createPersistentInboxHandlers,
  createPersistentNotifyHandler,
} from '@notifyhub/api';
import {
  CHANNEL_QUEUE_NAMES,
  closeHttpServer,
  createChannelQueueProducer,
  createDigestQueueProducer,
  createDlqProducer,
  createLogger,
  createOperationalMetrics,
  createOperationalRequestListener,
  createOperationalState,
  createPrismaClient,
  createRedisConnection,
  createRouteQueueProducer,
  createShutdownController,
  DIGEST_QUEUE_NAME,
  DLQ_QUEUE_NAME,
  DeliveryStatus,
  loadConfig,
  ROUTE_QUEUE_NAME,
  startOperationalServer,
  type OperationalMetrics,
  type PrismaClient,
  type ServiceRole,
} from '@notifyhub/core';
import {
  createDigestFlushHandler,
  createDigestFlushWorker,
  createEmailDeliveryHandler,
  createEmailProvider,
  createEmailWorker,
  createInAppDeliveryHandler,
  createInboxPublisher,
  createInAppWorker,
  createRouteNotificationHandler,
  createRouteWorker,
  createSmsDeliveryHandler,
  createSmsProvider,
  createSmsWorker,
  reconcilePersistedWork,
  type EmailDeliveryHandler,
  type EmailProvider,
  type SmsDeliveryHandler,
  type SmsProvider,
} from '@notifyhub/workers';

import { seedDemoFixtures } from './demo-fixtures.js';

type Closeable = { close(): Promise<unknown> };
const queueStates = ['waiting', 'active', 'delayed', 'failed', 'completed', 'paused'] as const;

function closeAll(resources: readonly Closeable[]): Promise<void> {
  return resources.reduce(
    (previous, resource) => previous.then(async () => void (await resource.close())),
    Promise.resolve(),
  );
}

function createInspectors(redisUrl: string): readonly Queue[] {
  const connection = createRedisConnection(redisUrl);
  return [
    ROUTE_QUEUE_NAME,
    ...Object.values(CHANNEL_QUEUE_NAMES),
    DIGEST_QUEUE_NAME,
    DLQ_QUEUE_NAME,
  ].map((name) => new Queue(name, { connection }));
}

function createMetricsRefresh(
  prisma: PrismaClient,
  metrics: OperationalMetrics,
  inspectors: readonly Queue[],
): () => Promise<void> {
  return async () => {
    metrics.queueJobs.reset();
    for (const queue of inspectors) {
      const counts = await queue.getJobCounts(...queueStates);
      for (const state of queueStates) {
        metrics.queueJobs.set({ queue: queue.name, state }, counts[state] ?? 0);
      }
    }
    metrics.deliveries.reset();
    const deliveries = await prisma.delivery.groupBy({ by: ['channel', 'status'], _count: true });
    for (const row of deliveries) {
      metrics.deliveries.set({ channel: row.channel, status: row.status }, row._count);
    }
    metrics.dlqSize.set(await prisma.delivery.count({ where: { status: DeliveryStatus.DLQ } }));
  };
}

function instrument<T>(
  metrics: OperationalMetrics,
  handler: (id: string) => Promise<T>,
  logger: ReturnType<typeof createLogger>,
  idField: 'notificationId' | 'deliveryId' | 'batchId',
) {
  return async (id: string): Promise<T> => {
    const end = metrics.workerDuration.startTimer();
    try {
      const result = await handler(id);
      metrics.workerJobs.inc({ outcome: 'success' });
      end({ outcome: 'success' });
      logger.info({ event: 'job_completed', [idField]: id }, 'Worker job completed');
      return result;
    } catch (error) {
      metrics.workerJobs.inc({ outcome: 'failure' });
      end({ outcome: 'failure' });
      logger.warn({ event: 'job_failed', [idField]: id }, 'Worker job failed');
      throw error;
    }
  };
}

function instrumentEmail(provider: EmailProvider, metrics: OperationalMetrics): EmailProvider {
  return {
    name: provider.name,
    async send(message) {
      const end = metrics.providerDuration.startTimer({
        channel: 'EMAIL',
        provider: provider.name,
      });
      try {
        const result = await provider.send(message);
        end({ outcome: 'success' });
        return result;
      } catch (error) {
        end({ outcome: 'failure' });
        throw error;
      }
    },
  };
}

function instrumentSms(provider: SmsProvider, metrics: OperationalMetrics): SmsProvider {
  return {
    name: provider.name,
    async send(message) {
      const end = metrics.providerDuration.startTimer({ channel: 'SMS', provider: provider.name });
      try {
        const result = await provider.send(message);
        end({ outcome: 'success' });
        return result;
      } catch (error) {
        end({ outcome: 'failure' });
        throw error;
      }
    },
  };
}

async function runApi(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config, 'api');
  const prisma = createPrismaClient(config.databaseUrl);
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1 });
  const routeJobs = createRouteQueueProducer(config.redisUrl);
  const channelJobs = createChannelQueueProducer(config.redisUrl);
  const digestJobs = createDigestQueueProducer(config.redisUrl);
  const dlq = createDlqProducer(config.redisUrl);
  const inspectors = createInspectors(config.redisUrl);
  const inbox = createPersistentInboxHandlers(prisma, config.tokenSecret);
  const metrics = createOperationalMetrics('api');
  const state = createOperationalState('api', [
    async () => void (await prisma.$queryRaw`SELECT 1`),
    async () => void (await redis.ping()),
  ]);
  const refreshMetrics = createMetricsRefresh(prisma, metrics, inspectors);
  const dlqHandlers = createPersistentDlqHandlers(prisma, dlq);
  const app = createApp({
    apiKey: config.apiKey,
    notify: createPersistentNotifyHandler(prisma, routeJobs),
    dashboard: createPersistentDashboardHandlers(prisma, config.demoUserId),
    dashboardAssetsDirectory: path.resolve('packages/dashboard/dist'),
    dlq: { operatorKey: config.operatorKey, ...dlqHandlers },
    inbox: { tokenSecret: config.tokenSecret, ...inbox },
    operations: { state, metrics, refreshMetrics, logger },
  });
  const server = createServer(app);
  const gateway = await createInboxWebSocketGateway({
    server,
    redisUrl: config.redisUrl,
    tokenSecret: config.tokenSecret,
    countUnread: inbox.countUnread,
    allowedOrigins: config.webSocketAllowedOrigins,
    onDiagnostic: (diagnostic) =>
      logger.warn({ event: 'websocket_diagnostic', code: diagnostic.code }, 'WebSocket diagnostic'),
  });
  await reconcilePersistedWork(prisma, { routeJobs, channelJobs, digestJobs, dlq }, new Date());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '0.0.0.0', () => resolve());
  });
  state.setReady(true);
  logger.info({ event: 'service_ready', port: config.port }, 'API ready');
  const controller = createShutdownController({
    state,
    logger,
    close: async () => {
      await closeHttpServer(server);
      await gateway.close();
      await closeAll([routeJobs, channelJobs, digestJobs, dlq, ...inspectors]);
      await redis.quit().catch(() => redis.disconnect());
      await prisma.$disconnect();
    },
  });
  controller.install();
}

async function runSeed(): Promise<void> {
  const config = loadConfig();
  const prisma = createPrismaClient(config.databaseUrl);
  try {
    await seedDemoFixtures(prisma, config.demoUserId);
  } finally {
    await prisma.$disconnect();
  }
}

async function runWorker(role: Exclude<ServiceRole, 'api'>): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config, role);
  const prisma = createPrismaClient(config.databaseUrl);
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1 });
  const metrics = createOperationalMetrics(role);
  const state = createOperationalState(role, [
    async () => void (await prisma.$queryRaw`SELECT 1`),
    async () => void (await redis.ping()),
  ]);
  const inspectors = createInspectors(config.redisUrl);
  const dependencies: Closeable[] = [];
  let worker: Closeable;

  if (role === 'router') {
    const channels = createChannelQueueProducer(config.redisUrl);
    const digests = createDigestQueueProducer(config.redisUrl);
    dependencies.push(channels, digests);
    worker = createRouteWorker(
      config.redisUrl,
      instrument(
        metrics,
        createRouteNotificationHandler(
          prisma,
          channels,
          { EMAIL: config.email.provider, SMS: config.sms.provider, IN_APP: 'inapp' },
          undefined,
          digests,
        ),
        logger,
        'notificationId',
      ),
    );
  } else if (role === 'digest') {
    const channels = createChannelQueueProducer(config.redisUrl);
    dependencies.push(channels);
    worker = createDigestFlushWorker(
      config.redisUrl,
      instrument(
        metrics,
        createDigestFlushHandler(prisma, channels, {
          EMAIL: config.email.provider,
          SMS: config.sms.provider,
          IN_APP: 'inapp',
        }),
        logger,
        'batchId',
      ),
    );
  } else if (role === 'email') {
    const base = createEmailDeliveryHandler(
      prisma,
      instrumentEmail(createEmailProvider(config.email), metrics),
    );
    const measured = Object.assign(instrument(metrics, base, logger, 'deliveryId'), {
      prisma,
    }) as EmailDeliveryHandler;
    worker = createEmailWorker(config.redisUrl, measured);
  } else if (role === 'sms') {
    const base = createSmsDeliveryHandler(
      prisma,
      instrumentSms(createSmsProvider(config.sms), metrics),
    );
    const measured = Object.assign(instrument(metrics, base, logger, 'deliveryId'), {
      prisma,
    }) as SmsDeliveryHandler;
    worker = createSmsWorker(config.redisUrl, measured);
  } else {
    const publisher = createInboxPublisher(config.redisUrl);
    dependencies.push(publisher);
    worker = createInAppWorker(
      config.redisUrl,
      instrument(metrics, createInAppDeliveryHandler(prisma, publisher), logger, 'deliveryId'),
    );
  }

  const listener = createOperationalRequestListener(
    state,
    metrics,
    createMetricsRefresh(prisma, metrics, inspectors),
  );
  const server = await startOperationalServer(config.port, listener);
  state.setReady(true);
  logger.info({ event: 'service_ready', port: config.port }, 'Worker ready');
  const controller = createShutdownController({
    state,
    logger,
    close: async () => {
      await closeHttpServer(server);
      await worker.close();
      await closeAll([...dependencies, ...inspectors]);
      await redis.quit().catch(() => redis.disconnect());
      await prisma.$disconnect();
    },
  });
  controller.install();
}

const role = process.argv[2];
if (role === 'api') await runApi();
else if (role === 'seed') await runSeed();
else if (['router', 'digest', 'email', 'sms', 'inapp'].includes(role ?? '')) {
  await runWorker(role as Exclude<ServiceRole, 'api'>);
} else {
  throw new Error('Expected process role: api, seed, router, digest, email, sms, or inapp');
}
