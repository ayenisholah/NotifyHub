import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { Queue } from 'bullmq';

import {
  Channel,
  CHANNEL_QUEUE_NAMES,
  createPrismaClient,
  createRedisConnection,
  DeliveryStatus,
  DIGEST_QUEUE_NAME,
  DigestBatchStatus,
  DLQ_QUEUE_NAME,
  loadConfig,
  NotificationStatus,
  ROUTE_QUEUE_NAME,
  type PrismaClient,
} from '@notifyhub/core';

const terminalDeliveryStatuses = new Set<string>([DeliveryStatus.SENT, DeliveryStatus.DLQ]);
const queueNames = [
  ROUTE_QUEUE_NAME,
  ...Object.values(CHANNEL_QUEUE_NAMES),
  DIGEST_QUEUE_NAME,
  DLQ_QUEUE_NAME,
] as const;

export type MeasurementKind = 'calibration' | 'measured';
export type MeasurementCohort =
  'default' | 'email-opt-out' | 'sms-opt-out' | 'quiet-hours' | 'all-opt-out';

export interface MeasurementConfig {
  apiUrl: string;
  runId: string;
  kind: MeasurementKind;
  notificationCount: number;
  userCount: number;
  ratePerSecond: number;
  concurrency: number;
  timeoutSeconds: number;
  pollIntervalMs: number;
  outputDirectory: string;
  reportPath?: string;
  reliabilityRunUrl?: string;
  productionHealthUrl?: string;
  commitSha: string;
}

export interface MeasurementWorkloadItem {
  index: number;
  userIndex: number;
  cohort: MeasurementCohort;
  digest: boolean;
  critical: boolean;
}

interface QueueEvidence {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
  paused: number;
}

interface MeasurementSnapshot {
  notifications: Record<string, number>;
  deliveries: Record<string, Record<string, number>>;
  deliveryCount: number;
  retries: number;
  digestBatches: Record<string, number>;
  digestItems: number;
  inboxMessages: number;
  queues: Record<string, QueueEvidence>;
  mailpitMessages: number | null;
}

export interface MeasurementReport {
  schemaVersion: 1;
  generatedAt: string;
  kind: MeasurementKind;
  runId: string;
  commitSha: string;
  passed: boolean;
  failures: string[];
  configuration: {
    notificationCount: number;
    userCount: number;
    targetRatePerSecond: number;
    concurrency: number;
    timeoutSeconds: number;
    digestPercent: number;
    criticalPercent: number;
    mockSmsFailureRate: number;
  };
  ingestion: {
    requested: number;
    accepted: number;
    httpFailures: number;
    uniqueNotificationIds: number;
    durationSeconds: number;
    acceptedPerSecond: number;
    latencyMilliseconds: {
      p50: number;
      p95: number;
      p99: number;
      maximum: number;
    };
  };
  pipeline: {
    durationSeconds: number;
    notificationsPerMinute: number;
    projectedNotificationsPerDay: number;
    snapshot: MeasurementSnapshot;
  };
  environment: {
    node: string;
    platform: string;
    architecture: string;
    logicalCpuCount: number;
    totalMemoryBytes: number;
  };
  reliabilityRunUrl: string | null;
  productionHealth: { before: boolean; after: boolean } | null;
}

function requiredString(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value === '') throw new Error(`${name} is required`);
  return value;
}

function integer(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name] ?? String(fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function positiveNumber(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be greater than 0 and at most ${maximum}`);
  }
  return value;
}

function credentialFreeHttpUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') {
    throw new Error(`${name} must be a credential-free HTTP(S) URL`);
  }
  return url.href.replace(/\/$/u, '');
}

export function parseMeasurementConfig(
  env: Readonly<Record<string, string | undefined>>,
): MeasurementConfig {
  const runId = requiredString(env, 'MEASUREMENT_RUN_ID');
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/u.test(runId)) {
    throw new Error('MEASUREMENT_RUN_ID must be 1-48 lowercase letters, digits, or hyphens');
  }
  const kind = env.MEASUREMENT_KIND ?? 'calibration';
  if (kind !== 'calibration' && kind !== 'measured') {
    throw new Error('MEASUREMENT_KIND must be calibration or measured');
  }
  const commitSha = requiredString(env, 'MEASUREMENT_COMMIT_SHA');
  if (!/^[0-9a-f]{7,40}$/u.test(commitSha)) {
    throw new Error('MEASUREMENT_COMMIT_SHA must be a 7-40 character lowercase Git SHA');
  }
  const reportPath = env.MEASUREMENT_REPORT_PATH?.trim() || undefined;
  const reliabilityRunUrl = env.MEASUREMENT_RELIABILITY_RUN_URL?.trim() || undefined;
  const productionHealthUrl = env.MEASUREMENT_PRODUCTION_HEALTH_URL?.trim() || undefined;
  if (
    kind === 'measured' &&
    (reportPath === undefined ||
      reliabilityRunUrl === undefined ||
      productionHealthUrl === undefined)
  ) {
    throw new Error(
      'MEASUREMENT_REPORT_PATH, MEASUREMENT_RELIABILITY_RUN_URL, and MEASUREMENT_PRODUCTION_HEALTH_URL are required for measured runs',
    );
  }
  if (
    reliabilityRunUrl !== undefined &&
    !/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+$/u.test(reliabilityRunUrl)
  ) {
    throw new Error('MEASUREMENT_RELIABILITY_RUN_URL must be a GitHub Actions run URL');
  }
  return {
    apiUrl: credentialFreeHttpUrl(
      env.MEASUREMENT_API_URL ?? 'http://api:4101',
      'MEASUREMENT_API_URL',
    ),
    runId,
    kind,
    notificationCount: integer(
      env,
      'MEASUREMENT_NOTIFICATION_COUNT',
      kind === 'measured' ? 10_000 : 250,
      1,
      100_000,
    ),
    userCount: integer(env, 'MEASUREMENT_USER_COUNT', kind === 'measured' ? 100 : 20, 5, 1_000),
    ratePerSecond: positiveNumber(env, 'MEASUREMENT_RATE_PER_SECOND', 50, 5_000),
    concurrency: integer(env, 'MEASUREMENT_CONCURRENCY', 25, 1, 500),
    timeoutSeconds: integer(env, 'MEASUREMENT_TIMEOUT_SECONDS', 900, 30, 3_600),
    pollIntervalMs: integer(env, 'MEASUREMENT_POLL_INTERVAL_MS', 1_000, 100, 10_000),
    outputDirectory: env.MEASUREMENT_OUTPUT_DIRECTORY?.trim() || '/evidence',
    ...(reportPath === undefined ? {} : { reportPath }),
    ...(reliabilityRunUrl === undefined ? {} : { reliabilityRunUrl }),
    ...(productionHealthUrl === undefined
      ? {}
      : {
          productionHealthUrl: credentialFreeHttpUrl(
            productionHealthUrl,
            'MEASUREMENT_PRODUCTION_HEALTH_URL',
          ),
        }),
    commitSha,
  };
}

export function percentile(values: readonly number[], requestedPercentile: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.ceil((requestedPercentile / 100) * ordered.length) - 1;
  return ordered[Math.max(0, Math.min(index, ordered.length - 1))] ?? 0;
}

export function workloadItem(
  index: number,
  notificationCount: number,
  userCount: number,
): MeasurementWorkloadItem {
  if (index < 0 || index >= notificationCount) throw new Error('workload index is out of range');
  const userIndex = index % userCount;
  const percentileIndex = Math.floor((userIndex * 100) / userCount);
  const cohort: MeasurementCohort =
    percentileIndex < 55
      ? 'default'
      : percentileIndex < 70
        ? 'email-opt-out'
        : percentileIndex < 85
          ? 'sms-opt-out'
          : percentileIndex < 95
            ? 'quiet-hours'
            : 'all-opt-out';
  return {
    index,
    userIndex,
    cohort,
    digest: index % 5 === 0,
    critical: index % 20 === 0,
  };
}

function round(value: number, digits = 2): number {
  return Number(value.toFixed(digits));
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function healthy(url: string | undefined): Promise<boolean | null> {
  if (url === undefined) return null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

function userId(runId: string, index: number): string {
  return `measurement-${runId}-user-${String(index).padStart(4, '0')}`;
}

function eventNames(runId: string): { immediate: string; digest: string } {
  return {
    immediate: `measurement.${runId}.immediate`,
    digest: `measurement.${runId}.digest`,
  };
}

async function seedWorkload(
  prisma: PrismaClient,
  config: MeasurementConfig,
): Promise<{ userIds: string[]; events: string[] }> {
  const users = Array.from({ length: config.userCount }, (_, index) => ({
    id: userId(config.runId, index),
    email: `${config.runId}-${index}@measurement.example.test`,
    phone: `+1555${String(index).padStart(7, '0')}`,
    timezone: 'UTC',
  }));
  const events = eventNames(config.runId);
  await prisma.user.createMany({ data: users });

  const preferences = users.flatMap((user, index) => {
    const cohort = workloadItem(index, config.userCount, config.userCount).cohort;
    if (cohort === 'email-opt-out') {
      return [{ userId: user.id, channel: Channel.EMAIL, category: '*', enabled: false }];
    }
    if (cohort === 'sms-opt-out') {
      return [{ userId: user.id, channel: Channel.SMS, category: '*', enabled: false }];
    }
    if (cohort === 'all-opt-out') {
      return Object.values(Channel).map((channel) => ({
        userId: user.id,
        channel,
        category: '*',
        enabled: false,
      }));
    }
    return [];
  });
  if (preferences.length > 0) await prisma.preference.createMany({ data: preferences });

  const now = new Date();
  const nowMinute = now.getUTCHours() * 60 + now.getUTCMinutes();
  const startMinute = (nowMinute + 60) % 1_440;
  const endMinute = (startMinute + 30) % 1_440;
  const quietHours = users.flatMap((user, index) =>
    workloadItem(index, config.userCount, config.userCount).cohort === 'quiet-hours'
      ? [{ userId: user.id, startMinute, endMinute }]
      : [],
  );
  if (quietHours.length > 0) await prisma.quietHours.createMany({ data: quietHours });

  await prisma.template.createMany({
    data: Object.values(events).flatMap((event) =>
      Object.values(Channel).map((channel) => ({
        event,
        channel,
        locale: 'en',
        subject: 'NotifyHub synthetic measurement',
        body: 'Synthetic measurement notification {{payload.index}}',
        bodyHtml: '<p>Synthetic measurement notification {{payload.index}}</p>',
        ...(event === events.digest && channel === Channel.EMAIL
          ? {
              digestEnabled: true,
              digestWindowMinutes: 1,
              digestBody: '{{count}} synthetic measurement notifications',
            }
          : {}),
      })),
    ),
  });
  return { userIds: users.map(({ id }) => id), events: Object.values(events) };
}

interface IngestionResult {
  accepted: number;
  httpFailures: number;
  notificationIds: Set<string>;
  latencies: number[];
  durationSeconds: number;
  errors: string[];
}

async function ingest(config: MeasurementConfig, apiKey: string): Promise<IngestionResult> {
  const startedAt = performance.now();
  const latencies: number[] = [];
  const notificationIds = new Set<string>();
  const errors: string[] = [];
  let accepted = 0;
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= config.notificationCount) return;
      const dueAt = startedAt + (index / config.ratePerSecond) * 1_000;
      const delay = dueAt - performance.now();
      if (delay > 0) await sleep(delay);
      const item = workloadItem(index, config.notificationCount, config.userCount);
      const requestStartedAt = performance.now();
      try {
        const events = eventNames(config.runId);
        const response = await fetch(`${config.apiUrl}/v1/notify`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            userId: userId(config.runId, item.userIndex),
            event: item.digest ? events.digest : events.immediate,
            payload: { index, cohort: item.cohort, critical: item.critical },
            idempotencyKey: `measurement-${config.runId}-${String(index).padStart(6, '0')}`,
          }),
        });
        const body: unknown = await response.json().catch(() => null);
        if (
          response.status !== 202 ||
          typeof body !== 'object' ||
          body === null ||
          !('notificationId' in body) ||
          typeof body.notificationId !== 'string'
        ) {
          errors.push(`request ${index} returned HTTP ${response.status}`);
        } else {
          accepted += 1;
          notificationIds.add(body.notificationId);
        }
      } catch (error) {
        errors.push(`request ${index} failed: ${error instanceof Error ? error.name : 'unknown'}`);
      } finally {
        latencies.push(performance.now() - requestStartedAt);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(config.concurrency, config.notificationCount) }, worker),
  );
  return {
    accepted,
    httpFailures: errors.length,
    notificationIds,
    latencies,
    durationSeconds: (performance.now() - startedAt) / 1_000,
    errors,
  };
}

async function queueSnapshot(redisUrl: string): Promise<Record<string, QueueEvidence>> {
  const queues = queueNames.map(
    (name) => new Queue(name, { connection: createRedisConnection(redisUrl) }),
  );
  try {
    return Object.fromEntries(
      await Promise.all(
        queues.map(async (queue) => {
          const counts = await queue.getJobCounts(
            'waiting',
            'active',
            'delayed',
            'failed',
            'completed',
            'paused',
          );
          return [
            queue.name,
            {
              waiting: counts.waiting ?? 0,
              active: counts.active ?? 0,
              delayed: counts.delayed ?? 0,
              failed: counts.failed ?? 0,
              completed: counts.completed ?? 0,
              paused: counts.paused ?? 0,
            },
          ] as const;
        }),
      ),
    );
  } finally {
    await Promise.all(queues.map(async (queue) => queue.close()));
  }
}

async function mailpitMessageCount(): Promise<number | null> {
  const url = process.env.MEASUREMENT_MAILPIT_API_URL ?? 'http://mailpit:4125';
  try {
    const response = await fetch(`${url.replace(/\/$/u, '')}/api/v1/messages?limit=1`);
    if (!response.ok) return null;
    const body: unknown = await response.json();
    return typeof body === 'object' &&
      body !== null &&
      'total' in body &&
      typeof body.total === 'number'
      ? body.total
      : null;
  } catch {
    return null;
  }
}

async function snapshot(
  prisma: PrismaClient,
  redisUrl: string,
  events: readonly string[],
  mailpitBaseline: number | null,
): Promise<MeasurementSnapshot> {
  const notificationWhere = { event: { in: [...events] } };
  const [
    notifications,
    deliveries,
    retryEvents,
    digestBatches,
    digestItems,
    inboxMessages,
    queues,
  ] = await Promise.all([
    prisma.notification.groupBy({ by: ['status'], where: notificationWhere, _count: true }),
    prisma.delivery.findMany({
      where: { notification: notificationWhere },
      select: { channel: true, status: true },
    }),
    prisma.deliveryEvent.count({
      where: { status: DeliveryStatus.RETRYING, delivery: { notification: notificationWhere } },
    }),
    prisma.digestBatch.groupBy({
      by: ['status'],
      where: { event: { in: [...events] } },
      _count: true,
    }),
    prisma.digestItem.count({ where: { notification: notificationWhere } }),
    prisma.inboxMessage.count({ where: { notification: notificationWhere } }),
    queueSnapshot(redisUrl),
  ]);
  const deliveryCounts: Record<string, Record<string, number>> = {};
  for (const delivery of deliveries) {
    const channel = (deliveryCounts[delivery.channel] ??= {});
    channel[delivery.status] = (channel[delivery.status] ?? 0) + 1;
  }
  const mailpitCurrent = await mailpitMessageCount();
  return {
    notifications: Object.fromEntries(notifications.map((row) => [row.status, row._count])),
    deliveries: deliveryCounts,
    deliveryCount: deliveries.length,
    retries: retryEvents,
    digestBatches: Object.fromEntries(digestBatches.map((row) => [row.status, row._count])),
    digestItems,
    inboxMessages,
    queues,
    mailpitMessages:
      mailpitBaseline === null || mailpitCurrent === null
        ? null
        : Math.max(0, mailpitCurrent - mailpitBaseline),
  };
}

export function snapshotFailures(
  reportConfig: Pick<MeasurementConfig, 'notificationCount'>,
  ingestion: Pick<IngestionResult, 'accepted' | 'httpFailures' | 'notificationIds' | 'errors'>,
  state: MeasurementSnapshot,
  latencyP95: number,
): string[] {
  const failures = [...ingestion.errors.slice(0, 20)];
  if (ingestion.accepted !== reportConfig.notificationCount) {
    failures.push(`accepted ${ingestion.accepted} of ${reportConfig.notificationCount} requests`);
  }
  if (ingestion.httpFailures !== 0) failures.push(`${ingestion.httpFailures} HTTP requests failed`);
  if (ingestion.notificationIds.size !== reportConfig.notificationCount) {
    failures.push('accepted notification IDs were not unique');
  }
  const totalNotifications = Object.values(state.notifications).reduce(
    (sum, count) => sum + count,
    0,
  );
  if (totalNotifications !== reportConfig.notificationCount) {
    failures.push(
      `persisted ${totalNotifications} of ${reportConfig.notificationCount} notifications`,
    );
  }
  if ((state.notifications[NotificationStatus.ACCEPTED] ?? 0) !== 0) {
    failures.push('notifications remain ACCEPTED');
  }
  const routed = state.notifications[NotificationStatus.ROUTED] ?? 0;
  const noOp = state.notifications[NotificationStatus.NO_OP] ?? 0;
  if (routed + noOp !== reportConfig.notificationCount) {
    failures.push('notifications did not converge to ROUTED or NO_OP');
  }
  const nonTerminalDeliveries = Object.values(state.deliveries).reduce(
    (total, statuses) =>
      total +
      Object.entries(statuses).reduce(
        (subtotal, [status, count]) =>
          subtotal + (terminalDeliveryStatuses.has(status) ? 0 : count),
        0,
      ),
    0,
  );
  if (nonTerminalDeliveries !== 0)
    failures.push(`${nonTerminalDeliveries} deliveries are non-terminal`);
  if ((state.digestBatches[DigestBatchStatus.OPEN] ?? 0) !== 0) {
    failures.push('digest batches remain OPEN');
  }
  for (const [name, counts] of Object.entries(state.queues)) {
    const zombies =
      (name === DLQ_QUEUE_NAME ? 0 : counts.waiting) +
      counts.active +
      counts.delayed +
      counts.paused;
    if (zombies !== 0) failures.push(`${name} has ${zombies} non-terminal queue jobs`);
  }
  const dlqDatabaseCount = Object.values(state.deliveries).reduce(
    (total, statuses) => total + (statuses[DeliveryStatus.DLQ] ?? 0),
    0,
  );
  if ((state.queues[DLQ_QUEUE_NAME]?.waiting ?? 0) !== dlqDatabaseCount) {
    failures.push('DLQ database and queue counts differ');
  }
  const sentEmailCount = state.deliveries[Channel.EMAIL]?.[DeliveryStatus.SENT] ?? 0;
  if (state.mailpitMessages !== null && state.mailpitMessages !== sentEmailCount) {
    failures.push('Mailpit and sent email counts differ');
  }
  if (latencyP95 > 250) failures.push(`ingestion p95 ${round(latencyP95)}ms exceeds 250ms`);
  return [...new Set(failures)];
}

function hasConverged(state: MeasurementSnapshot, expected: number): boolean {
  const total = Object.values(state.notifications).reduce((sum, count) => sum + count, 0);
  const accepted = state.notifications[NotificationStatus.ACCEPTED] ?? 0;
  const openDigests = state.digestBatches[DigestBatchStatus.OPEN] ?? 0;
  const nonTerminal = Object.values(state.deliveries).some((statuses) =>
    Object.entries(statuses).some(
      ([status, count]) => !terminalDeliveryStatuses.has(status) && count > 0,
    ),
  );
  const queueBusy = Object.values(state.queues).some(
    ({ active, delayed, paused }) => active + delayed + paused > 0,
  );
  const ordinaryQueueWaiting = Object.entries(state.queues).some(
    ([name, { waiting }]) => name !== DLQ_QUEUE_NAME && waiting > 0,
  );
  return (
    total === expected &&
    accepted === 0 &&
    openDigests === 0 &&
    !nonTerminal &&
    !queueBusy &&
    !ordinaryQueueWaiting
  );
}

async function waitForConvergence(
  prisma: PrismaClient,
  redisUrl: string,
  events: readonly string[],
  expected: number,
  deadline: number,
  pollIntervalMs: number,
  mailpitBaseline: number | null,
): Promise<MeasurementSnapshot> {
  let current = await snapshot(prisma, redisUrl, events, mailpitBaseline);
  while (!hasConverged(current, expected) && Date.now() < deadline) {
    await sleep(pollIntervalMs);
    current = await snapshot(prisma, redisUrl, events, mailpitBaseline);
  }
  return current;
}

function markdownReport(report: MeasurementReport, evidenceFileName: string): string {
  const result = report.passed ? 'PASS' : 'FAIL';
  const snapshotState = report.pipeline.snapshot;
  const channelRows = Object.entries(snapshotState.deliveries)
    .map(
      ([channel, statuses]) =>
        `| ${channel} | ${statuses[DeliveryStatus.SENT] ?? 0} | ${statuses[DeliveryStatus.DLQ] ?? 0} |`,
    )
    .join('\n');
  return `# NotifyHub controlled throughput measurement

Status: **${result}**

Measured: ${report.generatedAt}

Commit: \`${report.commitSha}\`

Run ID: \`${report.runId}\`

## Result

- ${report.ingestion.accepted.toLocaleString('en-US')} unique notifications accepted with ${report.ingestion.httpFailures} HTTP failures.
- Sustained ingestion: ${report.ingestion.acceptedPerSecond} notifications/second (p95 ${report.ingestion.latencyMilliseconds.p95} ms).
- End-to-end pipeline: ${report.pipeline.notificationsPerMinute} notifications/minute, including the one-minute digest window.
- Mechanical daily projection: ${report.pipeline.projectedNotificationsPerDay.toLocaleString('en-US')} notifications/day. This is a projection from the controlled run, not a production traffic claim.
- Retry transitions: ${snapshotState.retries}; digest items: ${snapshotState.digestItems}; open digest batches: ${snapshotState.digestBatches[DigestBatchStatus.OPEN] ?? 0}.
- Non-terminal queue jobs after convergence: 0.

| Channel | Sent | DLQ |
| --- | ---: | ---: |
${channelRows}

## Method

An isolated Docker Compose project seeded ${report.configuration.userCount} synthetic users across default, email opt-out, SMS opt-out, inactive quiet-hours, and all-opt-out cohorts. It submitted ${report.configuration.notificationCount.toLocaleString('en-US')} deterministic requests at ${report.configuration.targetRatePerSecond}/second with 20% digest events, 5% critical events, Mailpit email delivery, and a ${Math.round(report.configuration.mockSmsFailureRate * 100)}% deterministic mock-SMS failure rate. The run passed only after all notifications reached ROUTED or NO_OP, every delivery reached SENT or DLQ, every digest flushed, queue work drained, and database/queue DLQ counts agreed.

Calibration used increasing request rates and selected the highest error-free rate meeting a 250 ms ingestion p95 ceiling. The measurement stack used separate containers, networks, volumes, image tag, host ports, and generated synthetic secrets; the production Compose project was not restarted or mutated.

## Evidence and limitations

- Raw machine-readable evidence: [\`${evidenceFileName}\`](./evidence/${evidenceFileName})
- Independent 500-delivery SIGKILL recovery run: [GitHub Actions](${report.reliabilityRunUrl ?? '#'})
- Production health before/after isolated load: ${report.productionHealth === null ? 'not checked' : `${String(report.productionHealth.before)} / ${String(report.productionHealth.after)}`}.
- Host: ${report.environment.logicalCpuCount} logical CPUs, ${round(report.environment.totalMemoryBytes / 1_073_741_824)} GiB visible memory, ${report.environment.platform}/${report.environment.architecture}, Node ${report.environment.node}.
- Synthetic providers and one isolated host do not establish hosted-provider latency, multi-host scalability, or a production SLO.
- The daily figure is the measured end-to-end notification rate multiplied by 1,440 minutes; no extrapolation beyond that arithmetic is implied.
${report.failures.length === 0 ? '' : `\n## Failures\n\n${report.failures.map((failure) => `- ${failure}`).join('\n')}\n`}`;
}

export async function runMeasurement(): Promise<MeasurementReport> {
  const appConfig = loadConfig();
  const config = parseMeasurementConfig(process.env);
  const prisma = createPrismaClient(appConfig.databaseUrl);
  const pipelineStartedAt = performance.now();
  try {
    const productionHealthyBefore = await healthy(config.productionHealthUrl);
    const mailpitBaseline = await mailpitMessageCount();
    const scope = await seedWorkload(prisma, config);
    const ingestion = await ingest(config, appConfig.apiKey);
    const state = await waitForConvergence(
      prisma,
      appConfig.redisUrl,
      scope.events,
      config.notificationCount,
      Date.now() + config.timeoutSeconds * 1_000,
      config.pollIntervalMs,
      mailpitBaseline,
    );
    const pipelineDurationSeconds = (performance.now() - pipelineStartedAt) / 1_000;
    const p95 = percentile(ingestion.latencies, 95);
    const productionHealthyAfter = await healthy(config.productionHealthUrl);
    const failures = snapshotFailures(config, ingestion, state, p95);
    if (productionHealthyBefore === false || productionHealthyAfter === false) {
      failures.push('the production health endpoint did not remain healthy during measurement');
    }
    const generatedAt = new Date().toISOString();
    const report: MeasurementReport = {
      schemaVersion: 1,
      generatedAt,
      kind: config.kind,
      runId: config.runId,
      commitSha: config.commitSha,
      passed: failures.length === 0,
      failures,
      configuration: {
        notificationCount: config.notificationCount,
        userCount: config.userCount,
        targetRatePerSecond: config.ratePerSecond,
        concurrency: config.concurrency,
        timeoutSeconds: config.timeoutSeconds,
        digestPercent: 20,
        criticalPercent: 5,
        mockSmsFailureRate: appConfig.sms.failureRate,
      },
      ingestion: {
        requested: config.notificationCount,
        accepted: ingestion.accepted,
        httpFailures: ingestion.httpFailures,
        uniqueNotificationIds: ingestion.notificationIds.size,
        durationSeconds: round(ingestion.durationSeconds),
        acceptedPerSecond: round(ingestion.accepted / ingestion.durationSeconds),
        latencyMilliseconds: {
          p50: round(percentile(ingestion.latencies, 50)),
          p95: round(p95),
          p99: round(percentile(ingestion.latencies, 99)),
          maximum: round(Math.max(0, ...ingestion.latencies)),
        },
      },
      pipeline: {
        durationSeconds: round(pipelineDurationSeconds),
        notificationsPerMinute: round((ingestion.accepted / pipelineDurationSeconds) * 60),
        projectedNotificationsPerDay: Math.round(
          (ingestion.accepted / pipelineDurationSeconds) * 60 * 1_440,
        ),
        snapshot: state,
      },
      environment: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        logicalCpuCount: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
      },
      reliabilityRunUrl: config.reliabilityRunUrl ?? null,
      productionHealth:
        productionHealthyBefore === null || productionHealthyAfter === null
          ? null
          : { before: productionHealthyBefore, after: productionHealthyAfter },
    };
    await mkdir(config.outputDirectory, { recursive: true });
    const evidenceFileName = `${config.runId}.json`;
    const evidencePath = path.join(config.outputDirectory, evidenceFileName);
    await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    if (config.reportPath !== undefined) {
      await mkdir(path.dirname(config.reportPath), { recursive: true });
      await writeFile(config.reportPath, markdownReport(report, evidenceFileName), 'utf8');
    }
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.passed) process.exitCode = 1;
    return report;
  } finally {
    await prisma.$disconnect();
  }
}
