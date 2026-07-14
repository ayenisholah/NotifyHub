import { describe, expect, it } from 'vitest';

import {
  parseMeasurementConfig,
  percentile,
  snapshotFailures,
  workloadItem,
} from '../packages/runtime/src/measurement.js';

const measuredEnvironment = {
  MEASUREMENT_RUN_ID: '20260714t120000z-abcdef0-10k',
  MEASUREMENT_KIND: 'measured',
  MEASUREMENT_COMMIT_SHA: 'abcdef0123456789abcdef0123456789abcdef01',
  MEASUREMENT_RELIABILITY_RUN_URL:
    'https://github.com/ayenisholah/NotifyHub/actions/runs/123456789',
  MEASUREMENT_PRODUCTION_HEALTH_URL: 'https://notifyhub.example.test/healthz',
  MEASUREMENT_REPORT_PATH: '/docs/measurements.md',
} as const;

describe('controlled measurement configuration', () => {
  it('applies measured-run defaults and validates evidence references', () => {
    expect(parseMeasurementConfig(measuredEnvironment)).toMatchObject({
      apiUrl: 'http://api:4101',
      kind: 'measured',
      notificationCount: 10_000,
      userCount: 100,
      ratePerSecond: 50,
      concurrency: 25,
      timeoutSeconds: 900,
      productionHealthUrl: 'https://notifyhub.example.test/healthz',
    });
  });

  it('rejects unsafe identifiers, credentialed URLs, and incomplete measured runs', () => {
    expect(() =>
      parseMeasurementConfig({ ...measuredEnvironment, MEASUREMENT_RUN_ID: '../private' }),
    ).toThrow(/MEASUREMENT_RUN_ID/u);
    expect(() =>
      parseMeasurementConfig({
        ...measuredEnvironment,
        MEASUREMENT_API_URL: 'https://user:password@example.test',
      }),
    ).toThrow(/credential-free/u);
    expect(() =>
      parseMeasurementConfig({ ...measuredEnvironment, MEASUREMENT_REPORT_PATH: undefined }),
    ).toThrow(/required/u);
    expect(() =>
      parseMeasurementConfig({
        ...measuredEnvironment,
        MEASUREMENT_RELIABILITY_RUN_URL: 'https://example.test/private',
      }),
    ).toThrow(/GitHub Actions/u);
  });
});

describe('deterministic measurement workload', () => {
  it('uses the exact documented cohort, digest, and critical distribution', () => {
    const users = Array.from({ length: 100 }, (_, index) => workloadItem(index, 100, 100));
    expect(
      Object.fromEntries(
        [...new Set(users.map(({ cohort }) => cohort))].map((cohort) => [
          cohort,
          users.filter((item) => item.cohort === cohort).length,
        ]),
      ),
    ).toEqual({
      default: 55,
      'email-opt-out': 15,
      'sms-opt-out': 15,
      'quiet-hours': 10,
      'all-opt-out': 5,
    });

    const notifications = Array.from({ length: 10_000 }, (_, index) =>
      workloadItem(index, 10_000, 100),
    );
    expect(notifications.filter(({ digest }) => digest)).toHaveLength(2_000);
    expect(notifications.filter(({ critical }) => critical)).toHaveLength(500);
  });

  it('computes nearest-rank latency percentiles without mutating input', () => {
    const values = [40, 10, 30, 20];
    expect(percentile(values, 50)).toBe(20);
    expect(percentile(values, 95)).toBe(40);
    expect(percentile([], 95)).toBe(0);
    expect(values).toEqual([40, 10, 30, 20]);
  });
});

describe('measurement acceptance', () => {
  it('accepts only fully converged, queue-drained, cross-checked evidence', () => {
    expect(
      snapshotFailures(
        { notificationCount: 10_000 },
        {
          accepted: 10_000,
          httpFailures: 0,
          notificationIds: new Set(Array.from({ length: 10_000 }, (_, index) => String(index))),
          errors: [],
        },
        {
          notifications: { ROUTED: 9_500, NO_OP: 500 },
          deliveries: {
            EMAIL: { SENT: 8_000 },
            SMS: { SENT: 7_999, DLQ: 1 },
            IN_APP: { SENT: 9_500 },
          },
          deliveryCount: 25_500,
          retries: 400,
          digestBatches: { FLUSHED: 100 },
          digestItems: 1_500,
          inboxMessages: 9_500,
          queues: {
            dlq: {
              waiting: 1,
              active: 0,
              delayed: 0,
              failed: 0,
              completed: 0,
              paused: 0,
            },
          },
          mailpitMessages: 8_000,
        },
        20,
      ),
    ).toEqual([]);
  });

  it('reports latency, convergence, queue, and DLQ parity failures', () => {
    const failures = snapshotFailures(
      { notificationCount: 2 },
      {
        accepted: 1,
        httpFailures: 1,
        notificationIds: new Set(['one']),
        errors: ['request 1 returned HTTP 500'],
      },
      {
        notifications: { ACCEPTED: 1 },
        deliveries: { SMS: { RETRYING: 1, DLQ: 1 } },
        deliveryCount: 2,
        retries: 1,
        digestBatches: { OPEN: 1 },
        digestItems: 1,
        inboxMessages: 0,
        queues: {
          'send-sms': {
            waiting: 0,
            active: 0,
            delayed: 1,
            failed: 0,
            completed: 0,
            paused: 0,
          },
          dlq: {
            waiting: 0,
            active: 0,
            delayed: 0,
            failed: 0,
            completed: 0,
            paused: 0,
          },
        },
        mailpitMessages: 0,
      },
      300,
    );
    expect(failures.join('\n')).toMatch(/HTTP requests failed/u);
    expect(failures.join('\n')).toMatch(/remain ACCEPTED/u);
    expect(failures.join('\n')).toMatch(/deliveries are non-terminal/u);
    expect(failures.join('\n')).toMatch(/digest batches remain OPEN/u);
    expect(failures.join('\n')).toMatch(/non-terminal queue jobs/u);
    expect(failures.join('\n')).toMatch(/DLQ database and queue counts differ/u);
    expect(failures.join('\n')).toMatch(/exceeds 250ms/u);
  });
});
