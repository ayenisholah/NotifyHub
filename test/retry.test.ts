import { describe, expect, it } from 'vitest';

import {
  calculateDeliveryBackoff,
  createDeliveryBackoffStrategy,
  DELIVERY_BACKOFF_TYPE,
  DELIVERY_MAX_ATTEMPTS,
  DELIVERY_RETRY_JOB_OPTIONS,
} from '../packages/core/src/index.js';
import {
  classifyDeliveryError,
  EmailTemplateNotFoundError,
  ProviderDeliveryError,
} from '../packages/workers/src/index.js';

describe('delivery retry policy', () => {
  it('configures five attempts and the shared BullMQ backoff type', () => {
    expect(DELIVERY_MAX_ATTEMPTS).toBe(5);
    expect(DELIVERY_RETRY_JOB_OPTIONS).toEqual({
      attempts: 5,
      backoff: { type: DELIVERY_BACKOFF_TYPE, delay: 1_000 },
    });
  });

  it('calculates exponential delays with bounded injectable jitter', () => {
    expect([1, 2, 3, 4].map((attempt) => calculateDeliveryBackoff(attempt, () => 0))).toEqual([
      500, 1_000, 2_000, 4_000,
    ]);
    expect([1, 2, 3, 4].map((attempt) => calculateDeliveryBackoff(attempt, () => 1))).toEqual([
      1_000, 2_000, 4_000, 8_000,
    ]);
    expect(calculateDeliveryBackoff(1, () => -1)).toBe(500);
    expect(calculateDeliveryBackoff(1, () => 2)).toBe(1_000);
  });

  it('rejects unknown custom strategy names', () => {
    const strategy = createDeliveryBackoffStrategy(() => 0.5);
    expect(strategy(2, DELIVERY_BACKOFF_TYPE)).toBe(1_500);
    expect(() => strategy(1, 'unknown')).toThrow('Unsupported backoff strategy');
  });
});

describe('delivery error classification', () => {
  it('preserves sanitized provider retryability and status metadata', () => {
    const error = new ProviderDeliveryError('resend', true, {
      status: 503,
      label: 'resend email',
    });
    expect(classifyDeliveryError(error)).toEqual({
      retryable: true,
      message: 'resend email delivery failed (status 503)',
      kind: 'ProviderDeliveryError',
    });
    expect(error).toMatchObject({ provider: 'resend', status: 503 });
  });

  it('classifies domain failures as permanent and unknown errors as sanitized retryable failures', () => {
    expect(classifyDeliveryError(new EmailTemplateNotFoundError('private-event'))).toMatchObject({
      retryable: false,
      kind: 'EmailTemplateNotFoundError',
    });
    expect(classifyDeliveryError(new Error('private raw failure'))).toEqual({
      retryable: true,
      message: 'Unexpected delivery failure',
      kind: 'UnexpectedError',
    });
  });
});
