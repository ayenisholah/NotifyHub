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
  EMAIL_PROVIDER: z.enum(['mailpit', 'resend', 'sendgrid']),
  EMAIL_FROM: z.string().min(1, 'is required'),
  MAILPIT_HOST: z.string().optional(),
  MAILPIT_PORT: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  SENDGRID_API_KEY: z.string().optional(),
});

export type EmailProviderName = 'mailpit' | 'resend' | 'sendgrid';
export type EmailConfig =
  | Readonly<{ provider: 'mailpit'; from: string; host: string; port: number }>
  | Readonly<{ provider: 'resend'; from: string; apiKey: string }>
  | Readonly<{ provider: 'sendgrid'; from: string; apiKey: string }>;

export type AppConfig = Readonly<{
  databaseUrl: string;
  redisUrl: string;
  apiKey: string;
  operatorKey: string;
  tokenSecret: string;
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';
  email: EmailConfig;
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

  const email = parseEmailConfig(result.data);
  return Object.freeze({
    databaseUrl: result.data.DATABASE_URL,
    redisUrl: result.data.REDIS_URL,
    apiKey: result.data.API_KEY,
    operatorKey: result.data.OPERATOR_KEY,
    tokenSecret: result.data.TOKEN_SECRET,
    nodeEnv: result.data.NODE_ENV,
    port: result.data.PORT,
    logLevel: result.data.LOG_LEVEL,
    email: Object.freeze(email),
  });
}

function parseEmailConfig(data: z.infer<typeof environmentSchema>): EmailConfig {
  const issues: z.core.$ZodIssue[] = [];
  const required = (name: 'MAILPIT_HOST' | 'RESEND_API_KEY' | 'SENDGRID_API_KEY') => {
    const value = data[name];
    if (value === undefined || value.length === 0) {
      issues.push({ code: 'custom', path: [name], message: 'is required' });
      return '';
    }
    return value;
  };
  let email: EmailConfig;
  if (data.EMAIL_PROVIDER === 'mailpit') {
    const host = required('MAILPIT_HOST');
    const port = Number(data.MAILPIT_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      issues.push({
        code: 'custom',
        path: ['MAILPIT_PORT'],
        message: 'must be between 1 and 65535',
      });
    email = { provider: 'mailpit', from: data.EMAIL_FROM, host, port };
  } else if (data.EMAIL_PROVIDER === 'resend') {
    email = { provider: 'resend', from: data.EMAIL_FROM, apiKey: required('RESEND_API_KEY') };
  } else {
    email = { provider: 'sendgrid', from: data.EMAIL_FROM, apiKey: required('SENDGRID_API_KEY') };
  }
  if (issues.length > 0) throw new ConfigurationError(issues);
  return email;
}

export function loadConfig(): AppConfig {
  return parseConfig(process.env);
}
