# Progress Log (append-only)

After completing or abandoning a task, append an entry. Never rewrite earlier entries. This file and [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) are the trusted cross-session state.

```text
## YYYY-MM-DD — <task id>
- Did: <what happened, including failures>
- Verify: PASS | FAIL (<evidence>)
- Next: <first unchecked task>
- Blockers/notes: <handoff context>
```

---

## 2026-07-12 — P0-1 (in progress)

- Did: inspected the reference task protocol; removed a premature broad application scaffold; created the ordered plan, milestone gates, decision log, and uppercase progress log.
- Verify: NOT RUN. Governance verification still needs alignment and execution.
- Next: P0-1 remains active.
- Blockers/notes: do not begin W1D1-1 or restore product code until P0-1 passes.

## 2026-07-12 — P0-1

- Did: completed the governance scaffold; added repository standards, a sanitized product specification, ordered implementation plan, evidence-based milestones, decisions, append-only progress protocol, CI, publication exclusions, and cross-platform verification. Removed all premature product code and generated build artifacts.
- Verify: PASS (`scripts/verify.ps1`; required files and publication exclusions confirmed).
- Next: W1D1-1 — TypeScript workspace scaffold.
- Blockers/notes: work must remain one task per verified change. No application behavior is currently claimed.

## 2026-07-12 — W1D1-1

- Did: added the Node.js 22 npm-workspaces scaffold for private core, API, and workers packages; strict ESM TypeScript project references; ESLint, Prettier, Vitest, build and verification commands; a package-boundary test; lockfile-based CI; and reliable native-command failure propagation in the Windows verifier. Corrected the canonical specification reference to `docs/notifyhub-engineering-doc.md` and removed the competing summary document.
- Verify: PASS (`npm ci`; `scripts/verify.ps1`; `bash scripts/verify.sh`; format check, lint, strict compilation, clean workspace build, and 1 Vitest test all passed; npm audit reported 0 vulnerabilities).
- Next: W1D1-2 — Validated configuration.
- Blockers/notes: runtime dependencies and application behavior remain intentionally absent. Add Zod and environment parsing only in W1D1-2.

## 2026-07-12 — W1D1-2

- Did: added Zod as a core runtime dependency; exported immutable typed environment parsing and process-environment loading; validated PostgreSQL, Redis, secrets, environment, port, and Pino-compatible log levels; added redacted aggregate configuration errors, safe local examples, and focused tests without wiring API or worker startup.
- Verify: PASS (`npm ci`; `scripts/verify.ps1`; `bash scripts/verify.sh`; format check, lint, strict compilation, build, and 9 Vitest tests all passed; npm audit reported 0 vulnerabilities; `git diff --check`).
- Next: W1D1-3 — Prisma schema and migration.
- Blockers/notes: secrets remain required in every environment. No dotenv, database client, Redis connection, provider variables, or service boot process was added.

## 2026-07-12 — W1D1-3

- Did: added Prisma 7 with the PostgreSQL driver adapter; modeled the complete core schema; committed the initial migration with check, partial-open-digest, and unread-inbox indexes; exported a lazy client factory; added clean-database PostgreSQL 18 migration and uniqueness tests; and moved Docker-backed verification to GitHub Actions while keeping local verification Docker-free.
- Verify: PASS (`npm ci`; Prisma validate/generate; `scripts/verify.ps1`; `bash scripts/verify.sh`; format, lint, strict compilation, build, 9 local Vitest tests, and PostgreSQL 18 GitHub Actions integration tests passed; `npm audit` reported 0 vulnerabilities; `git diff --check`).
- Next: W1D2-1 — API authentication and request validation.
- Blockers/notes: generated Prisma client code remains untracked and deterministic. The migration is deployment-ready but was not applied to the VPS; deployment credentials and automation remain a later explicit task.

## 2026-07-12 — W1D2-1

- Did: added an injectable Express 5 application factory for `POST /v1/notify`; constant-time exact bearer authentication before body parsing; strict Zod request validation; stable 400, 401, 413, 422, and sanitized 500 JSON errors; and focused Supertest coverage without startup, persistence, queue, or environment coupling.
- Verify: PASS (`npm ci`; `scripts/verify.ps1`; `bash scripts/verify.sh`; format, lint, strict compilation, build, and 31 Vitest tests including 22 API tests all passed; `npm audit` reported 0 vulnerabilities; `git diff --check`).
- Next: W1D2-2 — Persist-first idempotent ingestion.
- Blockers/notes: the Docker-backed PostgreSQL integration suite remains delegated to GitHub Actions and could not run locally because no container runtime was available. Replay behavior, persistence, and queueing remain intentionally deferred to W1D2-2.

## 2026-07-12 — W1D2-2

- Did: added Prisma-backed persist-first notification ingestion; global idempotency conflict replay with original IDs and no duplicate enqueue; 202/200 response selection; a BullMQ route producer with stable queue, job name, payload, and UUID job identity; and PostgreSQL/Redis integration coverage for concurrency, immutable replays, independent unkeyed requests, commit-before-enqueue, retained rows after queue failure, sanitized failures, and queue cleanup without a worker.
- Verify: PASS (`npm ci` with a workspace-local cache; `scripts/verify.ps1`; `bash scripts/verify.sh`; format, lint, strict compilation, build, and 33 local Vitest tests all passed; focused API tests passed; `git diff --check`). Docker-backed PostgreSQL/Redis suites were collected but could not run locally because no container runtime is installed; they remain required by GitHub Actions.
- Next: W1D2-3 — Atomic delivery timeline transitions.
- Blockers/notes: user creation, router consumption, and automated reconciliation of accepted rows after Redis failure remain deferred. Accepted rows are intentionally not deleted when enqueueing fails.

## 2026-07-12 — W1D2-3

- Did: added atomic queued/scheduled delivery creation with initial events; compare-and-set delivery transitions with a forward-only state graph; typed missing, stale, and invalid-state errors; monotonic attempt validation; state-specific provider/error metadata; and PostgreSQL coverage for the complete graph, concurrent winners, terminal and stale rejection, ordered timelines, and rollback when event insertion fails.
- Verify: PASS (`scripts/verify.ps1`; `bash scripts/verify.sh`; format, lint, strict compilation, build, and local Vitest tests passed; `npm audit`; `git diff --check`). Docker-backed lifecycle integration remains required by GitHub Actions because no local container runtime is installed.
- Next: W1D3-1 — Router and template discovery.
- Blockers/notes: router/worker consumers and DLQ retry semantics remain deferred. Future delivery state changes must use the exported lifecycle helpers; `DLQ → QUEUED` is intentionally not supported yet.

## 2026-07-12 — W1D3-1

- Did: added English-template discovery; atomic accepted-to-routed/no-op notification handling; queued delivery/event creation with injected provider selection; restart-safe routed replay; unique notification/channel deliveries; stable email, SMS, and in-app BullMQ jobs; a real route worker; and PostgreSQL/Redis coverage for matching, explained no-ops, concurrency, partial enqueue recovery, and queue consumption without channel workers.
- Verify: PASS (`scripts/verify.ps1`; `bash scripts/verify.sh`; format, lint, strict compilation, build, and local Vitest tests passed; `npm audit`; `git diff --check`). Docker-backed router integration remains required by GitHub Actions because no local container runtime is installed.
- Next: W1D3-2 — Preference precedence.
- Blockers/notes: preference evaluation, critical overrides, digests, quiet-hours scheduling, and channel consumers remain deferred. Router replays intentionally enqueue stable delivery IDs so BullMQ deduplicates completed fan-out after partial Redis failure. Runtime channel queues use hyphens because BullMQ 5 rejects the specification's conceptual colon-separated labels.

## 2026-07-12 — W1D3-2

- Did: added pure exported preference resolution for exact, longest suffix-wildcard prefix, global, and default-enabled rules; added an exported table-tested routing evaluator covering missing templates, preferences, critical payloads, quiet hours, digests, and immediate delivery; filtered template channels independently inside the router transaction; recorded matched categories in delivery-event details; and made fully disabled notifications stable explained no-ops.
- Verify: PASS (`scripts/verify.ps1`; `bash scripts/verify.sh`; format, lint, strict compilation, build, and 47 local Vitest tests passed; `npm audit`; `git diff --check`). Docker-backed router integration remains required by GitHub Actions because no local container runtime is installed.
- Next: W1D3-3 — Quiet-hours scheduling.
- Blockers/notes: the router deliberately supplies inactive quiet-hours and digest inputs; W1D3-3 and W2D1 activate those branches without changing precedence. Preference strings are interpreted at read time, and routed/no-op results remain immutable across preference changes.
