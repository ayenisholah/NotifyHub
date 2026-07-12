import type { JobsOptions } from 'bullmq';

export const DELIVERY_MAX_ATTEMPTS = 5;
export const DELIVERY_BACKOFF_BASE_MS = 1_000;
export const DELIVERY_BACKOFF_TYPE = 'notifyhub-exponential-jitter';

export const DELIVERY_RETRY_JOB_OPTIONS: Readonly<JobsOptions> = Object.freeze({
  attempts: DELIVERY_MAX_ATTEMPTS,
  backoff: { type: DELIVERY_BACKOFF_TYPE, delay: DELIVERY_BACKOFF_BASE_MS },
});

export function calculateDeliveryBackoff(
  attemptsMade: number,
  random: () => number = Math.random,
): number {
  const nominal = DELIVERY_BACKOFF_BASE_MS * 2 ** Math.max(0, attemptsMade - 1);
  return Math.floor(nominal * (0.5 + Math.min(1, Math.max(0, random())) * 0.5));
}

export function createDeliveryBackoffStrategy(random: () => number = Math.random) {
  return (attemptsMade: number, type?: string): number => {
    if (type !== DELIVERY_BACKOFF_TYPE) throw new Error(`Unsupported backoff strategy: ${type}`);
    return calculateDeliveryBackoff(attemptsMade, random);
  };
}
