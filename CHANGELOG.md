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
- Established `docs/notifyhub-engineering-doc.md` as the canonical engineering source of truth.
