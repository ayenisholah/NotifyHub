import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

async function source(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

describe('container deployment contract', () => {
  it('builds an unprivileged production image with a role entrypoint', async () => {
    const dockerfile = await source('Dockerfile');
    const entrypoint = await source('scripts/container-entrypoint.sh');

    expect(dockerfile).toContain('FROM node:22-bookworm-slim AS base');
    expect(dockerfile).toContain('FROM base AS build');
    expect(dockerfile).toContain('FROM base AS runtime');
    expect(dockerfile).toContain('apt-get install --yes --no-install-recommends openssl');
    expect(dockerfile).toContain('npm prune --omit=dev');
    expect(dockerfile).toContain('USER node');
    expect(dockerfile).toContain('ENTRYPOINT ["notifyhub-entrypoint"]');
    expect(entrypoint).toContain('./node_modules/.bin/prisma migrate deploy');
    for (const role of ['api', 'router', 'digest', 'email', 'sms', 'inapp', 'demo']) {
      expect(entrypoint).toContain(role);
    }
  });

  it('keeps stateful and operational services private behind host Nginx', async () => {
    const compose = await source('compose.yaml');
    const nginx = await source('deploy/nginx/notifyhub.locations.conf');
    const standaloneNginx = await source('nginx.txt');

    for (const service of [
      'postgres',
      'redis',
      'mailpit',
      'api',
      'worker-router',
      'worker-digest',
      'worker-email',
      'worker-sms',
      'worker-inapp',
      'demo',
    ]) {
      expect(compose).toContain(`  ${service}:`);
    }
    expect(compose).toContain('backend:\n    internal: true');
    expect(compose).toContain('postgres-data:/var/lib/postgresql');
    expect(compose).not.toContain('postgres-data:/var/lib/postgresql/data');
    expect(compose).toContain('127.0.0.1:${NOTIFYHUB_DEMO_PORT:-4100}:4100');
    expect(compose).toContain('127.0.0.1:${NOTIFYHUB_API_PORT:-4101}:4101');
    expect(compose).toContain('127.0.0.1:${NOTIFYHUB_MAILPIT_UI_PORT:-4125}:4125');
    expect(compose).toMatch(/mailpit:[\s\S]*?networks:\s+- backend\s+- egress\s+healthcheck:/u);
    for (const port of [4100, 4101, 4111, 4112, 4113, 4114, 4115, 4125, 4126, 4132, 4137]) {
      expect(compose).toContain(String(port));
    }
    expect(compose.toLowerCase()).not.toContain('caddy');
    expect(compose).toContain('condition: service_healthy');
    expect(nginx).toContain('location = /v1/notify');
    expect(nginx).toContain('location ^~ /dashboard');
    expect(nginx).toContain('proxy_pass http://127.0.0.1:4100');
    expect(nginx).toContain('proxy_pass http://127.0.0.1:4101');
    expect(nginx).toContain('proxy_set_header Upgrade $http_upgrade');
    expect(nginx).not.toContain('/metrics');
    expect(nginx).not.toContain('/readyz');
    expect(standaloneNginx).toContain('server_name notifyhub.sholaayeni.xyz');
    expect(standaloneNginx).toContain('proxy_pass http://127.0.0.1:4100');
    expect(standaloneNginx).toContain('proxy_pass http://127.0.0.1:4101');
  });

  it('does not copy local secrets or generated output into the build context', async () => {
    const ignore = await source('.dockerignore');

    for (const excluded of ['.git', '.env', 'node_modules', '**/dist', 'test']) {
      expect(ignore.split(/\r?\n/u)).toContain(excluded);
    }
  });
});
