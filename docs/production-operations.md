# Production deployment and recovery

NotifyHub deploys automatically after a push to `main` passes the `conventions`, `verify`, `containers`, and `reliability` jobs. The `production` job is serialized, has no approval gate, and accepts only the exact `github.sha` from that successful `main` run. GitHub stores only the VPS SSH connection secrets; application and database secrets remain in the runner-owned `/opt/notifyhub/.env` file with mode `600`.

## Host layout

- `/opt/notifyhub/releases/<full-sha>` contains an immutable source release.
- `/opt/notifyhub-current` is an atomic symlink to the active release.
- `/opt/notifyhub/.env` is the persistent production configuration.
- `/opt/notifyhub/backups/<UTC timestamp>-<revision>` contains protected database and configuration backups.
- `/opt/notifyhub/deployments` records the previous release and pre-deployment backup for each SHA.
- `/opt/notifyhub/logs` contains cron output.

The deployment builds `notifyhub:<full-sha>` on the VPS and requires its `org.opencontainers.image.revision` label to equal that SHA. It validates Compose before rollout, creates and validates a backup of the running release, atomically updates the current symlink, applies migrations through the API entrypoint, waits for every Compose health check, checks the exact image on every application container, verifies loopback readiness, and installs cron. Only the latest three release directories and their full-SHA images are retained.

GitHub then verifies the live demo and dashboard metadata, social images, manifest, robots file, sitemap, WebSocket inbox journey, dashboard timeline, API-triggered delivery, and Mailpit email through an SSH tunnel. A failed Compose health check rolls back on the VPS immediately. A failed live acceptance run invokes `rollback-production.sh` from Actions. Neither path restores PostgreSQL automatically, because doing so could discard notifications accepted after the backup.

## Manual image rollback

For the SHA currently deployed, run as the configured privileged deployment account. Persistent configuration, backups, logs, and cron remain owned by `runner`:

```sh
/opt/notifyhub-current/scripts/rollback-production.sh <current-full-sha>
```

The command refuses a partial SHA, a non-current release, or a missing previous release. It restores the previous symlink, image configuration, and Compose topology, then checks loopback demo and API readiness. Inspect the failed release before retrying:

```sh
cd /opt/notifyhub-current
docker compose --project-name notifyhub --env-file /opt/notifyhub/.env ps
docker compose --project-name notifyhub --env-file /opt/notifyhub/.env logs --no-color
```

## Backups and database restoration

Every non-bootstrap deployment runs `production-backup.sh` before switching releases. The script takes a non-blocking lock, refuses a missing or unhealthy PostgreSQL service, creates a PostgreSQL custom-format dump, copies the protected environment, records resolved Compose configuration and a manifest, validates the dump with `pg_restore --list`, writes SHA-256 checksums, and marks the backup complete only after every step succeeds. Incomplete directories are removed. Backups older than 14 days are deleted and the newest 30 are capped.

To validate a backup before a restore:

```sh
cd /opt/notifyhub/backups/<backup-directory>
sha256sum --check SHA256SUMS
docker compose --project-name notifyhub \
  --project-directory /opt/notifyhub-current \
  --env-file /opt/notifyhub/.env \
  -f /opt/notifyhub-current/compose.yaml \
  exec -T postgres pg_restore --list < postgresql.dump
```

Always restore to a scratch database first and inspect it. A production database restore is an explicit incident decision: stop API and worker services, take another backup, document the accepted data-loss boundary, restore with `pg_restore --clean --if-exists --no-owner --no-privileges`, then restart the topology and run readiness plus the live journey. Do not restore the database merely because an application release was rolled back.

## Retention and cron

`install-production-cron.sh` owns a marked block in the `runner` crontab:

- `01:47 UTC` — locked daily protected backup.
- `02:17 UTC` — locked retention pass followed by backup pruning.

The one-shot `retention` role uses `DEMO_DATA_RETENTION_DAYS=7`. It records each BullMQ queue's previous pause state, pauses queues that were running, waits for active jobs to drain, removes expired completed/failed job history and terminal DLQ entries, deletes only terminal PostgreSQL notification graphs strictly older than the cutoff, preserves accepted/in-flight/delayed/digest work and fixture users/templates/preferences, then restores each prior queue state even after failure. Mailpit independently enforces its supported `MP_MAX_AGE=7d` policy.

Inspect cron and run either task manually as `runner`:

```sh
sudo crontab -u runner -l
/opt/notifyhub-current/scripts/production-backup.sh
/opt/notifyhub-current/scripts/production-maintenance.sh
```

If retention fails, confirm queue state and service readiness before rerunning. If backup fails, resolve storage, permission, PostgreSQL health, or checksum errors; deployment must not proceed without a valid pre-rollout backup when a current release exists.

## First-deployment closeout

W2D5-2 completed on 2026-07-14 with immutable revision `20d6ff16d9aedcf6458d191ce66b2d9c7f7894ca`. [GitHub Actions run 29369343184](https://github.com/ayenisholah/NotifyHub/actions/runs/29369343184) passed conventions, full verification and PostgreSQL integration, reliability, image/Compose/browser verification, scratch backup restoration, the VPS rollout, live public metadata, and the demo/dashboard/WebSocket/Mailpit journey. The deployment accepted the existing `.env` only after verifying mode `600`, installed the marked `runner` crontab, returned persistent production state to `runner` ownership, and verified the exact full-SHA image on every application container. This was a bootstrap release with no previous Compose release to back up; all subsequent deployments require a validated pre-rollout backup. W2D5-3 is next.
