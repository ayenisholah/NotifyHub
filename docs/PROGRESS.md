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

## 2026-07-12 — W1D3-3

- Did: added exported timezone-aware quiet-hours resolution with normal and midnight-crossing minute windows; activated email/SMS scheduling while keeping in-app and critical deliveries immediate; persisted scheduled delivery/event diagnostics; added delayed BullMQ channel jobs from persisted schedule times; preserved stable replay behavior with an injectable router clock; and documented boundary, equal-window, and DST approximation semantics.
- Verify: PASS (`scripts/verify.ps1`; `bash scripts/verify.sh`; format, lint, strict compilation, build, and 61 local Vitest tests passed; `npm audit`; `git diff --check`). Docker-backed PostgreSQL/Redis quiet-hours and delayed-job integration remains required by GitHub Actions because no local container runtime is installed.
- Next: W1D4-1 — Restart-safe in-app worker.
- Blockers/notes: digest evaluation remains inactive until W2D1. Scheduled channel workers may receive a past-due job immediately after queue recovery; they must continue to treat PostgreSQL as source of truth.

## 2026-07-12 — W1D4-1

- Did: corrected quiet-hours integration assertions to be independent of PostgreSQL enum ordering; added plain-text Handlebars in-app rendering with event-title fallback and missing-variable diagnostics; exposed transaction-scoped lifecycle transitions; atomically persisted inbox rows with processing/sent events; added idempotent sent/processing replay; published typed inbox envelopes after commit through a real Redis publisher; and added a BullMQ in-app worker with unit and PostgreSQL/Redis coverage.
- Verify: PASS (`scripts/verify.ps1`; `bash scripts/verify.sh`; format, lint, strict compilation, build, and 64 local Vitest tests passed; GitHub Actions run 29191868022 passed all 36 PostgreSQL/Redis integration tests; `npm audit`; `git diff --check`).
- Next: W1D4-2 — Email interface and Mailpit worker.
- Blockers/notes: inbox persistence is exactly once by notification; Redis publication is at least once and later consumers must deduplicate by inbox message ID. Retry/DLQ classification remains W1D5, and the WebSocket gateway remains W2D2-2.

## 2026-07-12 — W1D4-2

- Did: added mandatory discriminated email provider configuration; provider-neutral message/result contracts; injectable Mailpit SMTP, Resend, and SendGrid adapters with normalized message IDs and sanitized failures; shared Handlebars missing-variable diagnostics; separately escaped email HTML rendering; and an idempotent BullMQ email handler that records processing before provider I/O, preserves recoverable processing rows after failure, and completes sent replays without sending again. Added configuration, rendering, adapter, PostgreSQL lifecycle, concurrency, and real Redis/Mailpit worker coverage.
- Verify: PASS (format, lint, strict typecheck, build, and 72 local Vitest tests passed; `npm audit` reported 0 vulnerabilities; integration tests were collected locally and remain required in GitHub Actions because no container runtime is installed).
- Next: W1D4-3 — Deterministic mock-SMS worker.
- Blockers/notes: Resend has provider-level idempotency. SMTP and SendGrid retain a duplicate window if the process dies after provider acceptance but before the SENT transition. Retry classification, attempt limits, backoff, and DLQ policy remain W1D5.

## 2026-07-12 — W1D4-3

- Did: added required mock-SMS provider configuration with a validated failure rate; exported SMS provider/message/result contracts; implemented stable FNV-based failure decisions per delivery attempt, deterministic fake message IDs, injectable outcomes, and safe metadata-only logging; added shared plain-text SMS template rendering; and added an idempotent BullMQ SMS handler with typed delivery, provider, recipient, and template errors. Corrected the email integration fixture to reuse its unique English template within a multi-fixture test.
- Verify: PASS (format, strict typecheck, build, and 79 local Vitest tests passed; PostgreSQL/Redis integration coverage was added and collected but requires the GitHub Actions container runtime).
- Next: W1D5-1 — Five-attempt retry classification.
- Blockers/notes: simulated outcomes are stable for each delivery ID and persisted attempt, so W1D5 can test transient and permanent failures without process-order randomness. Retry transitions, backoff, jitter, terminal failure, and DLQ policy remain deferred to W1D5.

## 2026-07-12 — W1D5-1

- Did: added shared five-attempt BullMQ job policy with exponential 1-second-base backoff and bounded jitter; classified sanitized provider failures by HTTP/SMTP semantics; made mock-SMS failures retryable; classified channel validation errors as permanent; and added a shared failure recorder that advances PostgreSQL through processing/retrying or failed with monotonic attempts and append-only diagnostics. Email and SMS workers now stop permanent/exhausted jobs with BullMQ unrecoverable errors, while in-app publication receives queue retries without rewriting committed sent deliveries.
- Verify: PASS (format, strict typecheck, build, and 91 local Vitest tests passed; PostgreSQL/Redis integration coverage includes retry timelines, permanent preflight failure, fifth-attempt exhaustion, stable channel job policy, and fail-three-then-succeed execution; container-backed execution remains delegated to GitHub Actions).
- Next: W1D5-2 — DLQ storage and operator retry.
- Blockers/notes: W1D5-1 terminates exhausted and permanent deliveries at FAILED. Moving jobs to the dedicated DLQ, listing them, and explicit operator replay remain W1D5-2.

## 2026-07-12 — W1D5-2

- Did: added stable ID-only BullMQ dead-letter jobs backed by authoritative PostgreSQL DLQ rows; idempotent failed-to-DLQ parking; opaque newest-first DLQ pagination; independently operator-key-authenticated inspection and replay endpoints; and a dedicated DLQ-to-queued reset that clears attempts and errors while preserving the historical event timeline. Operator replay removes stale channel/DLQ jobs, creates a fresh five-attempt channel job, and can resume after a database-commit/Redis-enqueue failure.
- Verify: PASS (format, strict typecheck, build, and 96 local Vitest tests passed; PostgreSQL/Redis integration coverage includes poison parking, listing, repair, requeue, and successful completion; container-backed execution remains delegated to GitHub Actions).
- Next: W1D5-3 — Worker-kill acceptance test.
- Blockers/notes: PostgreSQL remains listable if Redis parking fails. W1D5-3 adds the broader reconciliation and process-kill acceptance sweep for arbitrary in-flight drift.

## 2026-07-12 — W1D5-3 (M1)

- Did: added idempotent persisted-work reconciliation for accepted notifications, nonterminal deliveries, failed deliveries, and missing DLQ jobs; exposed testable BullMQ worker recovery timing; added a real forked email worker harness; and added an isolated 500-delivery reliability suite that kills the worker after Mailpit accepts SMTP but before SENT persistence, restarts processing, verifies terminal convergence, permits only the documented duplicate, and confirms poison DLQ parking. Added shell and PowerShell entrypoints plus scheduled/manual GitHub Actions execution.
- Verify: PASS (format, strict typecheck, standard build/tests, and focused reconciliation tests pass locally; the Docker-backed 500-delivery SIGKILL gate is isolated under `npm run test:kill` for Linux GitHub Actions where a container runtime is available).
- Next: W2D1-1 — Race-safe digest batches.
- Blockers/notes: SMTP can duplicate across the provider-send/database-commit boundary; the acceptance gate proves and bounds that window rather than claiming exactly once. Production scheduling of reconciliation remains part of later operations work.

## 2026-07-12 — W2D1-1

- Did: added a database constraint requiring digest bodies for enabled templates; exported a stable five-attempt delayed digest-flush queue; implemented atomic PostgreSQL open-batch upsert and idempotent membership; activated email/SMS digest routing while preserving preference, critical, quiet-hours, and in-app precedence; made pure-digest and mixed routed replays stable; and extended reconciliation to restore missing open-batch jobs.
- Verify: PASS (Prisma generation, format, strict typecheck, build, and 98 local Vitest tests passed; PostgreSQL/Redis coverage includes 20-way batch contention, mixed immediate/digest routing, template constraint enforcement, stable delayed jobs, and reconciliation; container-backed execution remains delegated to GitHub Actions).
- Next: W2D1-2 — Digest flush worker.
- Blockers/notes: an open batch remains joinable until the flush worker claims it, so scheduler lag may slightly extend the collection window. Rendering, batch claim, delivery creation, and channel dispatch remain W2D1-2.

## 2026-07-12 — W2D1-2

- Did: added a nullable unique digest-batch delivery relation; atomically claimed open batches and created one queued delivery/event; made flush replay recover channel enqueue failures; added a BullMQ flush worker; and rendered ordered digest items through email and SMS without changing ordinary rendering.
- Verify: PASS (Prisma generation, format, lint, strict typecheck, build, and local Vitest suite).
- Next: W2D2-1 — User-scoped inbox REST.
- Blockers/notes: provider calls remain in channel workers, and digest email intentionally emits plain text because templates expose only one digest body.

## 2026-07-12 — W2D2-1

- Did: added reusable 15-minute HMAC-SHA256 user tokens with deterministic issue/verify clocks; API-key-protected token issuance for existing users; bearer-token-scoped inbox listing with opaque stable cursors and unread counts; and idempotent single/all read mutations that preserve the first read timestamp. All reads and writes derive tenant identity from the verified token subject and return indistinguishable not-found responses for missing and cross-user messages.
- Verify: PASS (format, lint, strict typecheck, build, and focused token/API tests; PostgreSQL integration coverage was added for tied-time pagination, cursor stability, unread counts, concurrent reads, replay, and tenant isolation, with execution delegated to CI because no local container runtime was available).
- Next: W2D2-2 — Authenticated WebSocket gateway (M2).
- Blockers/notes: tokens intentionally use the existing TOKEN_SECRET identity boundary so the WebSocket gateway can reuse the verifier; read-all covers rows unread when its transaction executes, so concurrently arriving messages may remain unread.

## 2026-07-12 — W2D2-2 (M2)

- Did: added a raw `/ws/inbox?token=…` gateway that attaches independently to a Node HTTP server; authenticates one canonical query token at upgrade time; derives rooms solely from the verified subject; sends initial and post-message authoritative unread counts; validates shared core Redis envelopes before user-isolated routing; supports multiple sockets per user; and provides injectable payload-free diagnostics. Added typed client-event, subscriber, room, lifecycle, and error contracts; moved inbox wire constants/contracts into core with worker compatibility re-exports; and added complete idempotent shutdown of upgrades, subscriptions, sockets, listeners, and Redis connections.
- Verify: PASS (`npm run verify`; format, lint, strict typecheck, build, and 133 local Vitest tests passed). Real HTTP/WebSocket tests cover missing, duplicate, malformed, tampered, future, and expired credentials; verified-subject propagation; multiple sockets; cross-user isolation; message/unread ordering; invalid envelopes; room cleanup; and idempotent shutdown. PostgreSQL unread-count and Redis worker-publication integration coverage remains collected for the container-backed CI suite.
- Next: W2D3-1 — Packable React/vanilla widget.
- Blockers/notes: token expiry is intentionally enforced only during connection establishment. Redis pub/sub remains non-durable and at-least-once; consumers deduplicate by inbox message ID. Heartbeats, origin policy, metrics, and process-wide shutdown orchestration remain W2D4-1.

## 2026-07-12 — W2D3-1

- Did: completed `@notifyhub/widget` as a React component and idempotent vanilla mount API; added complete REST/WebSocket payload validation, newest-first message deduplication, cursor pagination, optimistic single/all read reconciliation, identity-safe resets, capped reconnect with polling fallback, accessible focus and Escape behavior, neutral CSS variables, and package exports with external React peers. Added deterministic jsdom component coverage and wired it into repository verification.
- Verify: PASS (`npm run verify`; format, lint, strict typecheck, workspace build, 133 repository tests, and 5 widget tests passed; clean Vite output contained runnable ESM, declarations, source map, and `dist/styles.css`; `npm pack --dry-run` contained every exported path; built React and vanilla exports imported successfully).
- Next: W2D3-2 — Accessible neutral demo host.
- Blockers/notes: advanced visual customization, isolation, and the fake SaaS host remain scoped to W2D3-2. The widget treats REST and WebSocket unread values as authoritative and polls every 30 seconds only while realtime is disconnected.

## 2026-07-13 — W2D3-2

- Did: added the accessible neutral Acme Projects demo host with a server-side user-token bootstrap, same-origin inbox REST and WebSocket proxies, an Nginx configuration template, and production-build smoke coverage; added the project overview; and verified the remote GitHub repository and demo-host access guardrails.
- Verify: PASS (`npm run verify`; production demo smoke; `git diff --check`; credential scan; key-only VPS SSH; GitHub visibility, access, `main` ruleset, production environment, reviewer, branch policy, and secret-name queries).
- Next: W2D3-3 — Sanitized public dashboard.
- Blockers/notes: no deployment claim is made. Compose topology, TLS, deployment automation, and the operator dashboard remain deferred to their ordered roadmap tasks.

## 2026-07-13 — W2D3-3

- Did: added synthetic-demo-user-scoped public dashboard queries and routes; a responsive dark React dashboard with sanitized counters, opaque notification/DLQ pagination, per-channel timelines, visibility-aware polling, and accessible loading, error, empty, focus, and status behavior; memory-only operator-key unlocking for protected DLQ retries; optional `/dashboard` static serving; and production artifact, API, persistence, and component coverage.
- Verify: PASS (fresh `npm ci`; `npm run verify`; format, lint, strict typecheck, clean workspace builds, demo/dashboard production smokes, 160 core/API tests, 5 widget tests, 6 demo-host tests, and 20 dashboard tests; `npm audit` reported 0 vulnerabilities; `git diff --check`; credential scan; and the clean-checkout GitHub Actions run including 62 PostgreSQL/Redis integration tests).
- Next: W2D4-1 — Health, readiness, metrics, shutdown.
- Blockers/notes: public reads remain restricted to the configured synthetic demo user and expose only allowlisted lifecycle metadata. The operator key is never persisted or included in public API state. This host has no container runtime, so the Docker-capable Actions job is authoritative for integration execution. Health checks, metrics, process-wide shutdown, Compose, TLS, browser suites, and deployment remain deferred to their ordered tasks.

## 2026-07-14 — W2D4-1

- Did: added deployable API, router, digest, email, SMS, and in-app process entrypoints; per-process liveness, dependency-aware readiness, Prometheus process/HTTP/queue/delivery/DLQ/worker/provider metrics; redacted Pino lifecycle, request, and correlated job logs; startup persisted-work reconciliation; exact production WebSocket origin allowlisting and ping/pong stale-client cleanup; and idempotent, bounded signal/fatal-error shutdown across HTTP, WebSocket, BullMQ, Redis, and Prisma resources.
- Verify: PASS (`npm run verify`; clean artifacts, format, lint, strict typecheck, workspace builds, demo/dashboard security smokes, 168 core/API tests, 5 widget tests, 6 demo-host tests, and 20 dashboard tests). Operational coverage verifies liveness/readiness separation, sanitized dependency failures, Prometheus exposition, shutdown idempotency/deadlines, production origin configuration, browser-origin rejection, origin-less clients, and heartbeat survival.
- Next: W2D4-2 — Images and Compose topology.
- Blockers/notes: operational endpoints intentionally have no application authentication and must remain on internal container networks or behind deployment-layer access controls. External provider probes are excluded from readiness to avoid restart loops. This host has no container runtime, so PostgreSQL/Redis integration remains delegated to the Docker-capable Actions job; container images, Compose health checks, and TLS remain W2D4-2.

## 2026-07-14 — W2D4-2

- Did: added the non-root multi-stage application image, role-aware migration/startup entrypoint, private Compose topology, PostgreSQL 18 and Redis persistence, Mailpit, isolated API/worker/demo services, health-gated dependencies, a dedicated `41xx` port range, loopback host bindings, host-Nginx routing, container-safe demo networking, deployment contract tests, and a Docker-capable CI smoke/restart gate.
- Verify: PASS (`npm run verify`; format, lint, strict typecheck, clean production builds, security smokes, 171 core/API tests, 5 widget tests, 6 demo-host tests, and 20 dashboard tests; focused deployment contracts and shell syntax passed). GitHub Actions run `29324521587` built the production image, validated Compose and host-Nginx configuration, started the complete health-gated topology, reached the demo, dashboard, and loopback Mailpit endpoints, restarted the email worker, and passed the PostgreSQL 18 migration and integration suite.
- Next: W2D4-3 — CI integration and browser suites (M3).
- Blockers/notes: this host has no Docker runtime, so the Docker-capable Actions job is authoritative for the container gate. Synthetic demo fixtures and browser proof were deferred to W2D4-3.

## 2026-07-14 — W2D4-3 (M3)

- Did: added idempotent synthetic demo user and three-channel template fixtures; a health-gated one-shot Compose seed service; an exact-origin, per-client and globally rate-limited public demo trigger with a fixed server-side payload; accessible trigger feedback; and a Playwright Chromium journey covering live inbox delivery, persisted read state, dashboard channel timelines, and Mailpit receipt. The browser gate exposed a connected-socket delivery gap, so the widget now retains authoritative persistence reconciliation while WebSocket delivery remains the immediate path; the public demo reconciles every second.
- Verify: PASS (`npm run verify`; format, lint, strict typecheck, clean production builds and security smokes; 171 core/API tests, 5 widget tests, 11 demo-host tests, and 20 dashboard tests). GitHub Actions run `29330810406` passed PostgreSQL 18 migrations and integration, built and started the complete health-gated Compose topology, passed loopback smokes, completed the public Chromium journey, and passed worker-restart recovery.
- Next: W2D5-1 — Controlled reliability and throughput evidence.
- Blockers/notes: the public trigger accepts no request payload and never exposes the API key. Mailpit remains loopback-only. This host has no Docker runtime, so the Docker-capable Actions run is the authoritative container and browser evidence.

## 2026-07-14 — W2D5-1

- Did: added a remote-only, rate-calibrated measurement role and runner-owned isolated Compose harness; seeded deterministic synthetic preference, quiet-hours, digest, critical, and all-opt-out cohorts; recorded run-scoped notification, delivery, retry, digest, queue, Mailpit, host, commit, and production-health evidence; and fixed a pre-existing SIGKILL exit-listener race plus attempt-correlated mock-SMS hashing exposed by remote execution. The first VPS run correctly failed on global calibration queue counts and Mailpit retention; the corrected run used queue baselines and a measurement-only 50,000-message Mailpit capacity.
- Verify: PASS (GitHub Actions push run `29351449838` passed verification, PostgreSQL/Redis integration, image/Compose/Nginx validation, browser journey, and worker restart; manual run `29351464129` passed the 500-delivery SIGKILL recovery gate. The isolated VPS run accepted 10,000/10,000 unique requests with 0 HTTP failures at 199.96/s and p95 62.51 ms; converged 9,500 routed and 500 intentional no-op notifications into 24,348 terminal deliveries with 408 retry transitions, 48 flushed digest batches, exact 6,848-message Mailpit parity, zero DLQ or residual queue work, and healthy production checks before/after. Raw evidence: `docs/evidence/20260714t173441z-a9795f1-10k.json`; report: `docs/measurements.md`; `git diff --check`; credential/private-ID scan.)
- Next: W2D5-2 — Production deployment.
- Blockers/notes: no production deployment or Compose restart occurred in this task. The measurement project, volumes, and runner checkout were removed after evidence collection. The 1,913,747/day figure is only the measured end-to-end rate multiplied by 1,440 and is not a production SLO or hosted-provider capacity claim.
