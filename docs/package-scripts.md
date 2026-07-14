# Package scripts and workspaces

The root [`package.json`](../package.json) is the command surface for this private npm workspace. It requires Node.js 22 or newer, pins npm 10.9.2 through `packageManager`, and delegates application roles to packages under `packages/*`.

## Workspace roles

| Workspace              | Responsibility                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `@notifyhub/api`       | HTTP API, authenticated WebSocket gateway, public dashboard API, and operational endpoints                 |
| `@notifyhub/core`      | Configuration, Prisma persistence, queues, routing rules, templates, providers, and shared lifecycle logic |
| `@notifyhub/workers`   | Router, digest, email, SMS, and in-app worker implementations                                              |
| `@notifyhub/runtime`   | Process entrypoints for the API, workers, fixture seed, measurement, and retention roles                   |
| `@notifyhub/widget`    | Packable React inbox plus the vanilla DOM adapter                                                          |
| `@notifyhub/demo-host` | Synthetic Acme Projects host and guarded public notification trigger                                       |
| `@notifyhub/dashboard` | Sanitized public delivery and dead-letter observability UI                                                 |

## Root commands

| Command                         | Purpose                                                                                           | Requirements and boundary                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `npm run assets:generate`       | Regenerates canonical demo and dashboard social images from their HTML sources.                   | Writes tracked PNG assets; run only when the source artwork changes.            |
| `npm run clean`                 | Removes TypeScript build output and the dashboard build.                                          | Safe preparation for a clean build.                                             |
| `npm run format`                | Rewrites supported files with Prettier.                                                           | Mutating developer command; inspect the resulting diff.                         |
| `npm run format:check`          | Checks formatting without rewriting files.                                                        | Included in verification.                                                       |
| `npm run lint`                  | Runs ESLint across the workspace.                                                                 | Included in verification.                                                       |
| `npm run typecheck`             | Typechecks project references and UI workspaces, building widget types where required.            | Included in verification.                                                       |
| `npm run build`                 | Builds TypeScript references, widget, demo host, and dashboard production assets.                 | Does not build the container image.                                             |
| `npm test`                      | Runs core/API, widget, demo-host, and dashboard unit suites.                                      | PostgreSQL and browser suites are separate.                                     |
| `npm run test:integration`      | Runs the PostgreSQL integration configuration.                                                    | Requires the integration environment supplied by GitHub Actions.                |
| `npm run test:e2e`              | Runs the Playwright public journey.                                                               | Requires a running topology plus demo, dashboard, and Mailpit URLs.             |
| `npm run test:kill`             | Builds and runs the worker-interruption reliability configuration.                                | The authoritative gate is GitHub-hosted `scripts/kill-test.sh`.                 |
| `npm run verify`                | Cleans, checks formatting and lint, typechecks, builds, runs UI smokes, and executes unit suites. | Useful as an aggregate command; only GitHub Actions results are authoritative.  |
| `npm run prisma:generate`       | Regenerates the Prisma client from the checked-in schema.                                         | Also runs automatically after dependency installation.                          |
| `npm run prisma:migrate:deploy` | Applies checked-in migrations without creating new migrations.                                    | Used by deployment and Compose startup.                                         |
| `npm run start:api`             | Starts the built API runtime role.                                                                | Requires built output and the complete validated environment.                   |
| `npm run start:router`          | Starts the persisted notification routing worker.                                                 | Requires PostgreSQL and Redis.                                                  |
| `npm run start:digest`          | Starts the digest flush worker.                                                                   | Requires PostgreSQL and Redis.                                                  |
| `npm run start:email`           | Starts the email delivery worker.                                                                 | Requires PostgreSQL, Redis, and its configured email provider.                  |
| `npm run start:sms`             | Starts the deterministic mock-SMS worker.                                                         | The current portfolio release does not send real SMS.                           |
| `npm run start:inapp`           | Starts the in-app persistence and publication worker.                                             | Requires PostgreSQL and Redis.                                                  |
| `npm run measure`               | Starts the controlled measurement runtime role.                                                   | Never run against production; the supported harness is the isolated VPS script. |
| `npm run retention`             | Runs one retention pass for PostgreSQL and BullMQ data.                                           | Production invokes this through the lock-protected runner cron.                 |

## Infrastructure commands

`docker compose up --build --wait` is the supported complete local topology. `scripts/verify.ps1` and `scripts/verify.sh` wrap repository verification, while GitHub Actions adds PostgreSQL 18, Compose, Nginx, production-image metadata, protected backup restoration, Chromium, and worker-restart coverage.

The measurement and production scripts are operational interfaces rather than casual developer commands. They enforce runner-owned paths, full-SHA revisions, lock files, secret permissions, backup validation, and rollback rules documented in [production operations](production-operations.md).
