import { describe, expect, it, vi } from 'vitest';

import {
  createMockSmsProvider,
  deterministicMockSmsOutcome,
  MockSmsProviderError,
  renderSmsTemplate,
} from '../packages/workers/src/index.js';

const message = {
  to: '+2348000000000',
  text: 'Hello <Ada>',
  idempotencyKey: 'delivery-id',
  attempt: 2,
};

describe('SMS template rendering', () => {
  it('renders nested values as unescaped plain text', () => {
    expect(
      renderSmsTemplate({
        body: '{{payload.author.name}} wrote {{payload.text}}',
        context: { payload: { author: { name: 'Ada' }, text: '<hello>' } },
      }),
    ).toBe('Ada wrote <hello>');
  });

  it('renders missing values empty and reports each path once', () => {
    const onWarning = vi.fn();
    expect(
      renderSmsTemplate({
        body: '{{user.name}} {{user.name}} {{payload.text}}',
        context: { user: {}, payload: {} },
        onWarning,
      }),
    ).toBe('  ');
    expect(onWarning.mock.calls.map(([warning]) => warning)).toEqual([
      { field: 'text', path: 'user.name' },
      { field: 'text', path: 'payload.text' },
    ]);
  });
});

describe('deterministic mock SMS provider', () => {
  it('returns stable attempt-specific message IDs and logs safe metadata', async () => {
    const logger = vi.fn();
    const provider = createMockSmsProvider({ provider: 'mock', failureRate: 0 }, { logger });
    await expect(provider.send(message)).resolves.toEqual({
      providerMessageId: 'mock-sms-delivery-id-2',
    });
    expect(logger).toHaveBeenCalledWith({
      outcome: 'sent',
      provider: 'mock',
      deliveryId: 'delivery-id',
      attempt: 2,
      recipient: '+2348000000000',
      providerMessageId: 'mock-sms-delivery-id-2',
    });
    expect(JSON.stringify(logger.mock.calls)).not.toContain(message.text);
  });

  it('makes identical deterministic decisions across instances and attempts', () => {
    const first = Array.from({ length: 20 }, (_, index) =>
      deterministicMockSmsOutcome('same-delivery', index + 1, 0.5),
    );
    const second = Array.from({ length: 20 }, (_, index) =>
      deterministicMockSmsOutcome('same-delivery', index + 1, 0.5),
    );
    expect(first).toEqual(second);
    expect(new Set(first)).toEqual(new Set([true, false]));
  });

  it('distributes failures independently across delivery IDs and retry attempts', () => {
    const deliveryIds = Array.from({ length: 10_000 }, (_, index) => `delivery-${index}`);
    const firstAttemptFailures = deliveryIds.filter((deliveryId) =>
      deterministicMockSmsOutcome(deliveryId, 1, 0.05),
    ).length;
    const exhausted = deliveryIds.filter((deliveryId) =>
      [1, 2, 3, 4, 5].every((attempt) => deterministicMockSmsOutcome(deliveryId, attempt, 0.05)),
    ).length;

    expect(firstAttemptFailures).toBeGreaterThanOrEqual(450);
    expect(firstAttemptFailures).toBeLessThanOrEqual(550);
    expect(exhausted).toBeLessThanOrEqual(1);
  });

  it('always succeeds at zero and always fails at one', async () => {
    expect(deterministicMockSmsOutcome('delivery', 1, 0)).toBe(false);
    expect(deterministicMockSmsOutcome('delivery', 1, 1)).toBe(true);
    const logger = vi.fn();
    const provider = createMockSmsProvider({ provider: 'mock', failureRate: 1 }, { logger });
    await expect(provider.send(message)).rejects.toBeInstanceOf(MockSmsProviderError);
    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failed', deliveryId: 'delivery-id', attempt: 2 }),
    );
  });

  it('supports injected attempt schedules', async () => {
    const outcome = vi.fn((_id: string, attempt: number) => attempt < 3);
    const provider = createMockSmsProvider({ provider: 'mock', failureRate: 0.75 }, { outcome });
    await expect(provider.send({ ...message, attempt: 2 })).rejects.toBeInstanceOf(
      MockSmsProviderError,
    );
    await expect(provider.send({ ...message, attempt: 3 })).resolves.toEqual({
      providerMessageId: 'mock-sms-delivery-id-3',
    });
    expect(outcome).toHaveBeenCalledWith('delivery-id', 2, 0.75);
  });
});
