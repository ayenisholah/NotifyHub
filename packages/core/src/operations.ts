import { createServer, type RequestListener, type Server } from 'node:http';

import pino, { type Logger } from 'pino';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

import type { AppConfig } from './config.js';

export type ServiceRole = 'api' | 'router' | 'digest' | 'email' | 'sms' | 'inapp';
export type ReadinessCheck = () => Promise<void>;

export interface OperationalState {
  readonly role: ServiceRole;
  readonly shuttingDown: boolean;
  setReady(value: boolean): void;
  beginShutdown(): void;
  health(): { status: 'ok' | 'shutting_down' };
  readiness(): Promise<{ status: 'ready' | 'not_ready' }>;
}

async function withTimeout(check: ReadinessCheck, timeoutMs: number): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('readiness check timed out')), timeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export function createOperationalState(
  role: ServiceRole,
  checks: readonly ReadinessCheck[] = [],
  timeoutMs = 2_000,
): OperationalState {
  let ready = false;
  let shuttingDown = false;
  return {
    role,
    get shuttingDown() {
      return shuttingDown;
    },
    setReady(value) {
      ready = value;
    },
    beginShutdown() {
      shuttingDown = true;
      ready = false;
    },
    health() {
      return { status: shuttingDown ? 'shutting_down' : 'ok' };
    },
    async readiness() {
      if (!ready || shuttingDown) return { status: 'not_ready' };
      try {
        await Promise.all(checks.map(async (check) => withTimeout(check, timeoutMs)));
        return { status: 'ready' };
      } catch {
        return { status: 'not_ready' };
      }
    },
  };
}

export function createLogger(config: Pick<AppConfig, 'logLevel'>, role: ServiceRole): Logger {
  return pino({
    level: config.logLevel,
    base: { service: role },
    redact: {
      paths: [
        'authorization',
        'cookie',
        'token',
        'payload',
        'recipient',
        'providerMessageId',
        'req.headers.authorization',
        'req.headers.cookie',
        'req.url',
      ],
      censor: '[Redacted]',
    },
  });
}

export interface OperationalMetrics {
  readonly registry: Registry;
  readonly httpRequests: Counter<'method' | 'route' | 'status_class'>;
  readonly httpDuration: Histogram<'method' | 'route'>;
  readonly queueJobs: Gauge<'queue' | 'state'>;
  readonly deliveries: Gauge<'channel' | 'status'>;
  readonly dlqSize: Gauge;
  readonly workerJobs: Counter<'outcome'>;
  readonly workerDuration: Histogram<'outcome'>;
  readonly providerDuration: Histogram<'channel' | 'provider' | 'outcome'>;
}

export function createOperationalMetrics(role: ServiceRole): OperationalMetrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service: role });
  collectDefaultMetrics({ register: registry, prefix: 'notifyhub_process_' });
  return {
    registry,
    httpRequests: new Counter({
      name: 'notifyhub_http_requests_total',
      help: 'HTTP requests by method, normalized route, and status class.',
      labelNames: ['method', 'route', 'status_class'],
      registers: [registry],
    }),
    httpDuration: new Histogram({
      name: 'notifyhub_http_request_duration_seconds',
      help: 'HTTP request duration in seconds.',
      labelNames: ['method', 'route'],
      registers: [registry],
    }),
    queueJobs: new Gauge({
      name: 'notifyhub_queue_jobs',
      help: 'Jobs in an allowlisted queue and state.',
      labelNames: ['queue', 'state'],
      registers: [registry],
    }),
    deliveries: new Gauge({
      name: 'notifyhub_deliveries',
      help: 'Current deliveries by channel and status.',
      labelNames: ['channel', 'status'],
      registers: [registry],
    }),
    dlqSize: new Gauge({
      name: 'notifyhub_dlq_size',
      help: 'Current dead-lettered delivery count.',
      registers: [registry],
    }),
    workerJobs: new Counter({
      name: 'notifyhub_worker_jobs_total',
      help: 'Worker jobs completed by safe outcome.',
      labelNames: ['outcome'],
      registers: [registry],
    }),
    workerDuration: new Histogram({
      name: 'notifyhub_worker_job_duration_seconds',
      help: 'Worker job duration by safe outcome.',
      labelNames: ['outcome'],
      registers: [registry],
    }),
    providerDuration: new Histogram({
      name: 'notifyhub_provider_duration_seconds',
      help: 'Provider call duration by channel, provider, and safe outcome.',
      labelNames: ['channel', 'provider', 'outcome'],
      registers: [registry],
    }),
  };
}

export function createOperationalRequestListener(
  state: OperationalState,
  metrics: OperationalMetrics,
  refreshMetrics?: () => Promise<void>,
): RequestListener {
  return (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET') {
      response.writeHead(404).end();
      return;
    }
    if (request.url === '/healthz') {
      const body = state.health();
      response.writeHead(body.status === 'ok' ? 200 : 503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
      return;
    }
    if (request.url === '/readyz') {
      void state.readiness().then((body) => {
        response.writeHead(body.status === 'ready' ? 200 : 503, {
          'Content-Type': 'application/json',
        });
        response.end(JSON.stringify(body));
      });
      return;
    }
    if (request.url === '/metrics') {
      void (async () => {
        try {
          await refreshMetrics?.();
          response.writeHead(200, { 'Content-Type': metrics.registry.contentType });
          response.end(await metrics.registry.metrics());
        } catch {
          response.writeHead(503, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ status: 'unavailable' }));
        }
      })();
      return;
    }
    response.writeHead(404).end();
  };
}

export function startOperationalServer(
  port: number,
  listener: RequestListener,
  host = '0.0.0.0',
): Promise<Server> {
  const server = createServer(listener);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

export function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
    server.closeIdleConnections();
  });
}

export interface ShutdownController {
  readonly shuttingDown: boolean;
  shutdown(exitCode?: number): Promise<void>;
  install(): () => void;
}

export function createShutdownController(options: {
  state: OperationalState;
  close: () => Promise<void>;
  logger: Pick<Logger, 'info' | 'error'>;
  timeoutMs?: number;
  exit?: (code: number) => void;
}): ShutdownController {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const exit = options.exit ?? ((code) => process.exit(code));
  let closing: Promise<void> | undefined;
  let requestedExitCode = 0;
  const shutdown = (exitCode = 0): Promise<void> => {
    if (closing !== undefined) {
      if (exitCode !== 0) requestedExitCode = exitCode;
      return closing;
    }
    requestedExitCode = exitCode;
    options.state.beginShutdown();
    options.logger.info({ event: 'shutdown_started' }, 'Shutdown started');
    closing = new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        options.logger.error({ event: 'shutdown_timeout' }, 'Shutdown timed out');
        exit(1);
        resolve();
      }, timeoutMs);
      timeout.unref();
      void options.close().then(
        () => {
          clearTimeout(timeout);
          options.logger.info({ event: 'shutdown_complete' }, 'Shutdown complete');
          if (requestedExitCode !== 0) exit(requestedExitCode);
          resolve();
        },
        () => {
          clearTimeout(timeout);
          options.logger.error({ event: 'shutdown_failed' }, 'Shutdown failed');
          exit(1);
          resolve();
        },
      );
    });
    return closing;
  };
  const onSignal = () => {
    if (closing !== undefined) {
      exit(1);
      return;
    }
    void shutdown();
  };
  const onFatal = () => void shutdown(1);
  return {
    get shuttingDown() {
      return closing !== undefined;
    },
    shutdown,
    install() {
      process.on('SIGTERM', onSignal);
      process.on('SIGINT', onSignal);
      process.on('uncaughtException', onFatal);
      process.on('unhandledRejection', onFatal);
      return () => {
        process.off('SIGTERM', onSignal);
        process.off('SIGINT', onSignal);
        process.off('uncaughtException', onFatal);
        process.off('unhandledRejection', onFatal);
      };
    },
  };
}
