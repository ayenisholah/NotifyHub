# Changelog

## 0.1.0 - Unreleased

- Added the governance scaffold and ordered implementation workflow.
- Added strict Node.js 22 TypeScript workspaces for shared core, API, and workers with formatting, linting, build, test, and CI verification.
- Added immutable, Zod-validated environment configuration with safe defaults, typed normalization, and redacted variable-specific errors.
- Added the PostgreSQL 18 Prisma persistence schema, initial migration, lazy core database client, constraint integration tests, and GitHub Actions database verification.
- Added an injectable Express 5 notification API boundary with constant-time bearer authentication, strict request validation, body limits, and stable sanitized errors.
- Added persist-first notification ingestion with global idempotency replay handling and a BullMQ route-queue producer with stable job identities.
- Added atomic delivery creation and compare-and-set lifecycle transitions with append-only timeline events and typed conflict errors.
- Added restart-safe English-template routing, explained no-op notifications, stable per-channel BullMQ jobs, and a real route worker.
- Added exact, longest-prefix, and global preference resolution with a pure routing-precedence evaluator, per-channel filtering, diagnostic delivery events, and stable fully-disabled no-ops.
- Added timezone-aware same-day and overnight quiet hours with scheduled delivery timelines and stable delayed BullMQ channel jobs, while critical and in-app notifications remain immediate.
- Added restart-safe in-app delivery processing with Handlebars rendering, atomic inbox/timeline persistence, and typed at-least-once Redis publication.
- Added provider-neutral email delivery with Mailpit SMTP, Resend and SendGrid HTTP adapters, consistent safe template rendering, explicit provider configuration, and a restart-safe BullMQ email worker.
- Added a deterministic mock-SMS provider and restart-safe BullMQ worker with reproducible attempt-based failures, safe delivery logs, plain-text template rendering, and explicit configuration.
- Added classified five-attempt delivery retries with exponential jittered BullMQ backoff, sanitized provider errors, monotonic PostgreSQL attempt timelines, and permanent/exhausted failure handling.
- Added PostgreSQL-authoritative dead-letter storage, stable BullMQ DLQ jobs, operator-key inspection and replay endpoints, and restart-safe fresh-attempt recovery.
- Added persisted-work reconciliation and a scheduled 500-delivery worker-kill reliability gate proving stalled-job recovery, terminal convergence, poison DLQ parking, and the documented SMTP duplicate window.
- Added race-safe digest batch creation and joining, stable delayed flush jobs, digest-aware routing and replay, template integrity constraints, and digest job reconciliation.
- Added an idempotent digest flush worker with an authoritative batch-to-delivery link and digest-aware email/SMS rendering.
- Added short-lived HMAC user tokens and tenant-scoped inbox pagination, unread counts, and idempotent single/all read-state REST endpoints.
- Added an authenticated raw WebSocket inbox gateway with verified-subject rooms, authoritative unread events, validated Redis routing, and idempotent lifecycle cleanup.
- Added a packable React and vanilla DOM inbox widget with validated REST and WebSocket loading, cursor pagination, optimistic read actions, reconnect polling fallback, accessible neutral UI, and external React peers.
- Added the accessible neutral Acme Projects demo host with server-side token bootstrap, same-origin inbox REST and WebSocket proxies, an Nginx configuration template, and production-build smoke coverage.
- Added a public synthetic-demo-user dashboard with sanitized lifecycle counters, notification timelines, opaque pagination, visibility-aware polling, in-memory DLQ retry unlocking, and optional `/dashboard` static hosting.
- Added a project overview describing NotifyHub's purpose, practical applications, architecture, reliability goals, and current capabilities.
- Established `docs/notifyhub-engineering-doc.md` as the canonical engineering source of truth.
