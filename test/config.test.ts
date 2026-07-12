import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ConfigurationError,
  loadConfig,
  parseConfig,
  type AppConfig,
} from '../packages/core/src/index.js';

const validEnvironment = {
  DATABASE_URL: 'postgresql://notifyhub:notifyhub@localhost:5432/notifyhub',
  REDIS_URL: 'redis://localhost:6379',
  API_KEY: 'api-key-for-local-development-only',
  OPERATOR_KEY: 'operator-key-for-local-development',
  TOKEN_SECRET: 'token-secret-for-local-development-',
  NODE_ENV: 'test',
  PORT: '8080',
  LOG_LEVEL: 'debug',
  EMAIL_PROVIDER: 'mailpit',
  EMAIL_FROM: 'notifyhub@example.test',
  MAILPIT_HOST: 'localhost',
  MAILPIT_PORT: '1025',
  SMS_PROVIDER: 'mock',
  MOCK_SMS_FAILURE_RATE: '0.25',
} as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('parseConfig', () => {
  it('normalizes a complete environment into an immutable typed configuration', () => {
    const config: AppConfig = parseConfig(validEnvironment);

    expect(config).toEqual({
      databaseUrl: validEnvironment.DATABASE_URL,
      redisUrl: validEnvironment.REDIS_URL,
      apiKey: validEnvironment.API_KEY,
      operatorKey: validEnvironment.OPERATOR_KEY,
      tokenSecret: validEnvironment.TOKEN_SECRET,
      nodeEnv: 'test',
      port: 8080,
      logLevel: 'debug',
      email: {
        provider: 'mailpit',
        from: 'notifyhub@example.test',
        host: 'localhost',
        port: 1025,
      },
      sms: { provider: 'mock', failureRate: 0.25 },
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('applies defaults and coerces numeric port strings', () => {
    const required = {
      DATABASE_URL: validEnvironment.DATABASE_URL,
      REDIS_URL: validEnvironment.REDIS_URL,
      API_KEY: validEnvironment.API_KEY,
      OPERATOR_KEY: validEnvironment.OPERATOR_KEY,
      TOKEN_SECRET: validEnvironment.TOKEN_SECRET,
      EMAIL_PROVIDER: validEnvironment.EMAIL_PROVIDER,
      EMAIL_FROM: validEnvironment.EMAIL_FROM,
      MAILPIT_HOST: validEnvironment.MAILPIT_HOST,
      MAILPIT_PORT: validEnvironment.MAILPIT_PORT,
      SMS_PROVIDER: validEnvironment.SMS_PROVIDER,
    };

    expect(parseConfig(required)).toMatchObject({
      nodeEnv: 'development',
      port: 4000,
      logLevel: 'info',
    });
  });

  it.each(['0', '65536', 'not-a-number'])("rejects invalid port '%s'", (port) => {
    expect(() => parseConfig({ ...validEnvironment, PORT: port })).toThrow(/PORT:/);
  });

  it('reports every missing required variable', () => {
    let error: unknown;
    try {
      parseConfig({});
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ConfigurationError);
    for (const name of [
      'DATABASE_URL',
      'REDIS_URL',
      'API_KEY',
      'OPERATOR_KEY',
      'TOKEN_SECRET',
      'EMAIL_PROVIDER',
      'EMAIL_FROM',
      'SMS_PROVIDER',
    ]) {
      expect((error as Error).message).toContain(name);
    }
  });

  it('defaults the mock SMS failure rate and validates its inclusive range', () => {
    expect(parseConfig({ ...validEnvironment, MOCK_SMS_FAILURE_RATE: undefined })).toMatchObject({
      sms: { provider: 'mock', failureRate: 0 },
    });
    for (const failureRate of ['0', '1']) {
      expect(
        parseConfig({ ...validEnvironment, MOCK_SMS_FAILURE_RATE: failureRate }),
      ).toMatchObject({ sms: { failureRate: Number(failureRate) } });
    }
    for (const failureRate of ['-0.1', '1.1', 'invalid']) {
      expect(() =>
        parseConfig({ ...validEnvironment, MOCK_SMS_FAILURE_RATE: failureRate }),
      ).toThrow(/MOCK_SMS_FAILURE_RATE/);
    }
    expect(() => parseConfig({ ...validEnvironment, SMS_PROVIDER: 'twilio' })).toThrow(
      /SMS_PROVIDER/,
    );
  });

  it('selects hosted providers and requires only their credential', () => {
    expect(
      parseConfig({ ...validEnvironment, EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_secret' }),
    ).toMatchObject({ email: { provider: 'resend', apiKey: 're_secret' } });
    expect(
      parseConfig({
        ...validEnvironment,
        EMAIL_PROVIDER: 'sendgrid',
        SENDGRID_API_KEY: 'sg_secret',
      }),
    ).toMatchObject({ email: { provider: 'sendgrid', apiKey: 'sg_secret' } });
    expect(() => parseConfig({ ...validEnvironment, EMAIL_PROVIDER: 'resend' })).toThrow(
      /RESEND_API_KEY/,
    );
  });

  it('rejects invalid email providers and Mailpit ports without exposing credentials', () => {
    expect(() =>
      parseConfig({
        ...validEnvironment,
        EMAIL_PROVIDER: 'unknown',
        RESEND_API_KEY: 'private-key',
      }),
    ).toThrow(/EMAIL_PROVIDER/);
    expect(() => parseConfig({ ...validEnvironment, MAILPIT_PORT: '70000' })).toThrow(
      /MAILPIT_PORT/,
    );
  });

  it('reports invalid URL schemes and short secrets by variable without exposing values', () => {
    const submittedValues = {
      DATABASE_URL: 'mysql://private-user:private-password@localhost/private',
      REDIS_URL: 'http://private-redis-host',
      API_KEY: 'short-api-secret',
      OPERATOR_KEY: 'short-operator-secret',
      TOKEN_SECRET: 'short-token-secret',
    };

    expect(() => parseConfig({ ...validEnvironment, ...submittedValues })).toThrowError(
      expect.objectContaining({
        message: expect.stringMatching(
          /DATABASE_URL[\s\S]*REDIS_URL[\s\S]*API_KEY[\s\S]*OPERATOR_KEY[\s\S]*TOKEN_SECRET/,
        ),
      }),
    );

    try {
      parseConfig({ ...validEnvironment, ...submittedValues });
    } catch (error) {
      for (const value of Object.values(submittedValues)) {
        expect((error as Error).message).not.toContain(value);
      }
    }
  });
});

describe('loadConfig', () => {
  it('reads process.env without mutating it', () => {
    for (const [name, value] of Object.entries(validEnvironment)) {
      vi.stubEnv(name, value);
    }
    const before = { ...process.env };

    expect(loadConfig()).toEqual(parseConfig(validEnvironment));
    expect(process.env).toEqual(before);
  });
});
