# Changelog

## 0.1.0 - Unreleased

- Added the governance scaffold and ordered implementation workflow.
- Added strict Node.js 22 TypeScript workspaces for shared core, API, and workers with formatting, linting, build, test, and CI verification.
- Added immutable, Zod-validated environment configuration with safe defaults, typed normalization, and redacted variable-specific errors.
- Added the PostgreSQL 18 Prisma persistence schema, initial migration, lazy core database client, constraint integration tests, and GitHub Actions database verification.
- Added an injectable Express 5 notification API boundary with constant-time bearer authentication, strict request validation, body limits, and stable sanitized errors.
- Established `docs/notifyhub-engineering-doc.md` as the canonical engineering source of truth.
