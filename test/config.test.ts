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
    for (const name of ['DATABASE_URL', 'REDIS_URL', 'API_KEY', 'OPERATOR_KEY', 'TOKEN_SECRET']) {
      expect((error as Error).message).toContain(name);
    }
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
