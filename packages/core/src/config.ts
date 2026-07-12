import { z } from 'zod';

const secretSchema = z.string().min(32, 'must contain at least 32 characters');

const environmentSchema = z.object({
  DATABASE_URL: z
    .string()
    .url('must be a valid URL')
    .refine((value) => ['postgres:', 'postgresql:'].includes(new URL(value).protocol), {
      message: 'must use the postgres: or postgresql: scheme',
    }),
  REDIS_URL: z
    .string()
    .url('must be a valid URL')
    .refine((value) => ['redis:', 'rediss:'].includes(new URL(value).protocol), {
      message: 'must use the redis: or rediss: scheme',
    }),
  API_KEY: secretSchema,
  OPERATOR_KEY: secretSchema,
  TOKEN_SECRET: secretSchema,
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce
    .number('must be numeric')
    .int('must be an integer')
    .min(1, 'must be between 1 and 65535')
    .max(65535, 'must be between 1 and 65535')
    .default(4000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
});

export type AppConfig = Readonly<{
  databaseUrl: string;
  redisUrl: string;
  apiKey: string;
  operatorKey: string;
  tokenSecret: string;
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';
}>;

export class ConfigurationError extends Error {
  public constructor(issues: readonly z.core.$ZodIssue[]) {
    const details = issues.map(
      (issue) => `${String(issue.path[0] ?? 'environment')}: ${issue.message}`,
    );
    super(`Invalid configuration:\n- ${details.join('\n- ')}`);
    this.name = 'ConfigurationError';
  }
}

export function parseConfig(env: Readonly<Record<string, string | undefined>>): AppConfig {
  const result = environmentSchema.safeParse(env);

  if (!result.success) {
    throw new ConfigurationError(result.error.issues);
  }

  return Object.freeze({
    databaseUrl: result.data.DATABASE_URL,
    redisUrl: result.data.REDIS_URL,
    apiKey: result.data.API_KEY,
    operatorKey: result.data.OPERATOR_KEY,
    tokenSecret: result.data.TOKEN_SECRET,
    nodeEnv: result.data.NODE_ENV,
    port: result.data.PORT,
    logLevel: result.data.LOG_LEVEL,
  });
}

export function loadConfig(): AppConfig {
  return parseConfig(process.env);
}
