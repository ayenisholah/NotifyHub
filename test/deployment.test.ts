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
    for (const role of [
      'api',
      'seed',
      'measure',
      'retention',
      'router',
      'digest',
      'email',
      'sms',
      'inapp',
      'demo',
    ]) {
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
      'seed-demo',
      'retention',
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
    expect(compose).toContain('condition: service_completed_successfully');
    expect(compose).toContain("profiles: ['maintenance']");
    expect(compose).toContain('MP_MAX_AGE: 7d');
    expect(compose).toContain("DEMO_DATA_RETENTION_DAYS: '${DEMO_DATA_RETENTION_DAYS:-7}'");
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

  it('defines immutable deployment, protected backup, rollback, and cron contracts', async () => {
    const dockerfile = await source('Dockerfile');
    const workflow = await source('.github/workflows/ci.yml');
    const deploy = await source('scripts/deploy-production.sh');
    const backup = await source('scripts/production-backup.sh');
    const rollback = await source('scripts/rollback-production.sh');
    const cron = await source('scripts/install-production-cron.sh');

    expect(dockerfile).toContain('org.opencontainers.image.revision=$VCS_REF');
    expect(workflow).toContain('needs: [conventions, verify, containers, reliability]');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('environment:\n      name: production');
    expect(workflow).toContain('rollback-production.sh');
    expect(deploy).toContain('notifyhub:$revision');
    expect(deploy).toContain('VCS_REF=$revision');
    expect(deploy).toContain('production-backup.sh');
    expect(backup).toContain('pg_dump');
    expect(backup).toContain('--format=custom');
    expect(backup).toContain('pg_restore --list');
    expect(backup).toContain('sha256sum');
    expect(backup).toContain('-mtime +14');
    expect(rollback).toContain('database restoration was not performed');
    expect(cron).toContain('47 1 * * *');
    expect(cron).toContain('17 2 * * *');
    expect(cron).toContain('flock -n');
    expect(cron).toContain('crontab -u "$cron_user"');
    expect(deploy).toContain('chown -R "$runtime_user:$runtime_user" "$root"');
  });

  it('does not copy local secrets or generated output into the build context', async () => {
    const ignore = await source('.dockerignore');

    for (const excluded of ['.git', '.env', 'node_modules', '**/dist', 'test']) {
      expect(ignore.split(/\r?\n/u)).toContain(excluded);
    }
  });

  it('keeps controlled measurement isolated, synthetic, and self-cleaning', async () => {
    const measurement = await source('scripts/measure.sh');

    expect(measurement).toContain('notifyhub-measurement-$short_sha');
    expect(measurement).toContain('NOTIFYHUB_IMAGE_TAG=$image_tag');
    expect(measurement).toContain('NOTIFYHUB_API_PORT=4201');
    expect(measurement).toContain('NOTIFYHUB_MAILPIT_UI_PORT=4225');
    expect(measurement).toContain('MOCK_SMS_FAILURE_RATE=0.05');
    expect(measurement).toContain('MEASUREMENT_NOTIFICATION_COUNT=10000');
    expect(measurement).toContain('MEASUREMENT_USER_COUNT=100');
    expect(measurement).toContain('compose down --volumes --remove-orphans');
    expect(measurement).toContain('openssl rand -hex 32');
    expect(measurement).toContain('MEASUREMENT_PRODUCTION_HEALTH_URL');
    expect(measurement).toContain('deploy/compose.measurement.yaml');
    expect(measurement).not.toContain('/opt/notifyhub');
    const measurementCompose = await source('deploy/compose.measurement.yaml');
    expect(measurementCompose).toContain("MP_MAX_MESSAGES: '50000'");
  });
});
