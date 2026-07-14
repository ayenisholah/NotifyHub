# NotifyHub v0.1.0

NotifyHub v0.1.0 is the first evidence-backed public release of the production-shaped multi-channel notification service.

## Highlights

- Persist-first, idempotent notification ingestion with PostgreSQL as the source of truth.
- Isolated BullMQ routing, digest, email, mock-SMS, and in-app workers.
- Preferences, quiet hours, digest batching, bounded retries, dead-letter inspection, and explicit replay.
- A packable React/vanilla inbox with WebSocket updates and polling fallback.
- A public synthetic demo and sanitized delivery dashboard.
- Immutable automatic production deployment with protected backups, live acceptance, and image/Compose rollback.

## Verified evidence

The controlled 10,000-notification run sustained 199.96 accepted notifications/second at p95 62.51 ms with zero HTTP failures and no residual queue work. A separate 500-delivery reliability gate killed and restarted an in-flight worker and proved terminal convergence.

This evidence used synthetic providers on one isolated host. It is not a production SLO, hosted-provider benchmark, or multi-node capacity claim.

- [Live demo](https://notifyhub.sholaayeni.xyz/)
- [Delivery dashboard](https://notifyhub.sholaayeni.xyz/dashboard)
- [Measurement method and limitations](https://github.com/ayenisholah/NotifyHub/blob/v0.1.0/docs/measurements.md)
- [Raw evidence](https://github.com/ayenisholah/NotifyHub/blob/v0.1.0/docs/evidence/20260714t173441z-a9795f1-10k.json)
- [Production deployment and recovery](https://github.com/ayenisholah/NotifyHub/blob/v0.1.0/docs/production-operations.md)

## Operational note

Database restoration remains a manual recovery decision. Automatic application rollback restores the previous immutable image and Compose release without silently discarding notifications accepted after the pre-rollout backup.
