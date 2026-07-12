import type { SmsConfig, SmsProviderName } from '@notifyhub/core';

export interface SmsMessage {
  to: string;
  text: string;
  idempotencyKey: string;
  attempt: number;
}

export interface SmsSendResult {
  providerMessageId: string;
}

export interface SmsProvider {
  readonly name: SmsProviderName;
  send(message: SmsMessage): Promise<SmsSendResult>;
}

export interface MockSmsLogEvent {
  outcome: 'sent' | 'failed';
  provider: 'mock';
  deliveryId: string;
  attempt: number;
  recipient: string;
  providerMessageId?: string;
}

export type MockSmsLogger = (event: MockSmsLogEvent) => void;
export type MockSmsOutcome = (deliveryId: string, attempt: number, failureRate: number) => boolean;

export class MockSmsProviderError extends Error {
  public constructor() {
    super('mock SMS delivery failed');
    this.name = 'MockSmsProviderError';
  }
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export const deterministicMockSmsOutcome: MockSmsOutcome = (deliveryId, attempt, failureRate) =>
  fnv1a(`${deliveryId}:${attempt}`) / 0x1_0000_0000 < failureRate;

export function createMockSmsProvider(
  config: SmsConfig,
  options: Readonly<{ outcome?: MockSmsOutcome; logger?: MockSmsLogger }> = {},
): SmsProvider {
  const outcome = options.outcome ?? deterministicMockSmsOutcome;
  const logger = options.logger ?? (() => undefined);
  return {
    name: 'mock',
    async send(message) {
      if (outcome(message.idempotencyKey, message.attempt, config.failureRate)) {
        logger({
          outcome: 'failed',
          provider: 'mock',
          deliveryId: message.idempotencyKey,
          attempt: message.attempt,
          recipient: message.to,
        });
        throw new MockSmsProviderError();
      }
      const providerMessageId = `mock-sms-${message.idempotencyKey}-${message.attempt}`;
      logger({
        outcome: 'sent',
        provider: 'mock',
        deliveryId: message.idempotencyKey,
        attempt: message.attempt,
        recipient: message.to,
        providerMessageId,
      });
      return { providerMessageId };
    },
  };
}

export function createSmsProvider(config: SmsConfig): SmsProvider {
  return createMockSmsProvider(config);
}
