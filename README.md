# NotifyHub

NotifyHub is an intentionally engineered multi-channel notification service with persist-first ingestion, isolated delivery workers, an inbox widget, a synthetic public dashboard, and explicit recovery behavior.

[Implementation plan](docs/IMPLEMENTATION_PLAN.md) · [Milestones](docs/MILESTONES.md) · [Progress](docs/PROGRESS.md) · [Engineering document](docs/notifyhub-engineering-doc.md)

## Status

M0 through M3, W2D5-1, and W2D5-2 have passed, including the production-shaped Compose topology, PostgreSQL integration, public Chromium journey, worker-kill recovery, [controlled 10,000-notification evidence](docs/measurements.md), and the first unattended production deployment. W2D5-3 evidence-backed release documentation is next.

The service accepts one authenticated product event and routes it to email, in-app inbox, and mock SMS while respecting preferences, quiet hours, digests, bounded retries, and an append-only delivery trail.

## Compose quickstart

Docker Compose runs the API, five isolated worker processes, the demo host, PostgreSQL 18, Redis, and Mailpit from one application build. The host's existing Nginx installation remains the TLS edge.

1. Copy `.env.example` to `.env` and replace every secret placeholder. Keep `POSTGRES_PASSWORD` URI-safe because it is included in the application database URL.
2. Run `docker compose up --build --wait`.
3. Open the demo at <http://127.0.0.1:4100>, use **Send demo notification**, inspect its delivery timeline at <http://127.0.0.1:4101/dashboard>, and view captured email at <http://127.0.0.1:4125>.

The topology applies migrations automatically, then idempotently provisions the synthetic demo user and three immediate `project.updated` channel templates before the demo starts. The public trigger accepts no caller-controlled recipients or payload, requires an allowed browser origin, and is limited per client and globally. For the VPS, `nginx.txt` is the standalone host configuration. If Nginx or Certbot already owns the domain's TLS server block, merge `deploy/nginx/notifyhub.locations.conf` into that existing block instead. Set `WS_ALLOWED_ORIGINS` to the site's exact HTTPS origin.

The dedicated port range is: demo `4100`, API `4101`, workers `4111–4115`, Mailpit UI/SMTP `4125/4126`, PostgreSQL `4132`, and Redis `4137`. Only the demo, API, and Mailpit UI bind to host loopback; workers and stateful services remain private. Nginx continues to own public ports 80 and 443.

## Verification

Run `scripts/verify.ps1` on Windows or `scripts/verify.sh` on Linux. The Docker-capable CI container job additionally validates Nginx routing, builds and starts the full topology, checks loopback services, runs the Chromium journey from public trigger through inbox, dashboard, and Mailpit, and restarts an isolated email worker.

The controlled measurement harness is intentionally remote-only: GitHub Actions runs the 500-delivery SIGKILL recovery gate, and `scripts/measure.sh` runs from a disposable, runner-owned VPS checkout with a separate Compose project, image tag, network, ports, volumes, and generated synthetic secrets. The accepted result sustained 199.96 notifications/second at p95 62.51 ms and converged 10,000 notifications with zero HTTP failures or residual queue work. See [the methodology, result, and limitations](docs/measurements.md); this evidence is not a production SLO or hosted-provider claim.

Production releases are automatic after every green `main` run and use immutable full-SHA images, pre-rollout protected backups, automatic image rollback, daily backup and retention cron, and live browser acceptance. See [production deployment and recovery](docs/production-operations.md). GitHub Actions and the VPS are the authoritative verification environments.

## License

MIT
