import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  closeHttpServer,
  createOperationalMetrics,
  createOperationalRequestListener,
  createOperationalState,
  createShutdownController,
  startOperationalServer,
} from '../packages/core/src/index.js';

const servers: Awaited<ReturnType<typeof startOperationalServer>>[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map(async (server) => closeHttpServer(server)));
});

async function start(state = createOperationalState('router')) {
  const metrics = createOperationalMetrics('router');
  const refresh = vi.fn(async () => metrics.dlqSize.set(3));
  const server = await startOperationalServer(
    0,
    createOperationalRequestListener(state, metrics, refresh),
    '127.0.0.1',
  );
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Server did not bind');
  return { baseUrl: `http://127.0.0.1:${address.port}`, metrics, refresh };
}

describe('operational endpoints', () => {
  it('separates liveness from dependency-aware readiness and shutdown', async () => {
    const check = vi.fn(async () => undefined);
    const state = createOperationalState('router', [check]);
    const { baseUrl } = await start(state);
    expect(await (await fetch(`${baseUrl}/healthz`)).json()).toEqual({ status: 'ok' });
    expect((await fetch(`${baseUrl}/readyz`)).status).toBe(503);
    state.setReady(true);
    expect((await fetch(`${baseUrl}/readyz`)).status).toBe(200);
    expect(check).toHaveBeenCalledOnce();
    state.beginShutdown();
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(503);
    expect((await fetch(`${baseUrl}/readyz`)).status).toBe(503);
  });

  it('returns sanitized readiness failures and Prometheus metrics', async () => {
    const state = createOperationalState('email', [
      async () => Promise.reject(new Error('secret')),
    ]);
    state.setReady(true);
    const { baseUrl, refresh } = await start(state);
    const readiness = await fetch(`${baseUrl}/readyz`);
    expect(await readiness.text()).toBe('{"status":"not_ready"}');
    const response = await fetch(`${baseUrl}/metrics`);
    const body = await response.text();
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(body).toContain('notifyhub_dlq_size{service="router"} 3');
    expect(body).not.toContain('secret');
    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe('shutdown controller', () => {
  it('runs cleanup once and preserves a later failure exit code', async () => {
    const close = vi.fn(async () => undefined);
    const exit = vi.fn();
    const logger = { info: vi.fn(), error: vi.fn() };
    const controller = createShutdownController({
      state: createOperationalState('sms'),
      close,
      logger,
      exit,
    });
    const first = controller.shutdown();
    const second = controller.shutdown(1);
    await Promise.all([first, second]);
    expect(close).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('forces termination when cleanup exceeds its deadline', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const controller = createShutdownController({
      state: createOperationalState('inapp'),
      close: () => new Promise(() => undefined),
      logger: { info: vi.fn(), error: vi.fn() },
      timeoutMs: 25,
      exit,
    });
    void controller.shutdown();
    await vi.advanceTimersByTimeAsync(25);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
