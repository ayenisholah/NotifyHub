# Implementation Plan — Plan of Record

Derived from the binding [NotifyHub engineering document](notifyhub-engineering-doc.md). If summaries conflict with that document, the engineering document wins.

Tasks are executed top to bottom. The first unchecked box is the current task. Do not skip, reorder, or batch tasks without an entry in [DECISIONS.md](DECISIONS.md). A task is complete only when its **Done when** condition and `scripts/verify` pass; then tick it, append [PROGRESS.md](PROGRESS.md), update the changelog, and commit one task.

## Phase 0 — Governance (M0)

- [x] **P0-1 — Governance and documentation scaffold**
  - Do: repository standards, rewritten specification, plan, milestones, decisions, progress protocol, verification, CI, and repository hygiene.
  - Done when: governance verification passes, publication excludes `sample/`, and the canonical engineering document is present under `docs/`.

## Week 1 — Reliable backend MVP

### Day 1 — Workspace and persistence

- [x] **W1D1-1 — TypeScript workspace scaffold**
  - Done when: Node 22 npm workspaces for core/API/workers compile strictly and a first unit test passes.
- [x] **W1D1-2 — Validated configuration**
  - Done when: valid, missing, and malformed environment tests pass.
- [x] **W1D1-3 — Prisma schema and migration**
  - Done when: the complete core schema migrates onto clean PostgreSQL and uniqueness constraints are tested.

### Day 2 — Ingestion and state

- [x] **W1D2-1 — API authentication and request validation**
  - Done when: positive and negative authentication/validation tests pass.
- [x] **W1D2-2 — Persist-first idempotent ingestion**
  - Done when: new requests return 202 and concurrent replays return 200 with one ID.
- [x] **W1D2-3 — Atomic delivery timeline transitions**
  - Done when: every state update appends its event transactionally.

### Day 3 — Routing

- [x] **W1D3-1 — Router and template discovery**
  - Done when: eligible templates create deliveries and missing templates create an explained no-op.
- [x] **W1D3-2 — Preference precedence**
  - Done when: global, event override, quiet-hours, then digest table tests pass.
- [x] **W1D3-3 — Quiet-hours scheduling**
  - Done when: normal and midnight-crossing windows schedule correctly in the user timezone.

### Day 4 — Channels

- [ ] **W1D4-1 — Restart-safe in-app worker**
- [ ] **W1D4-2 — Email interface and Mailpit worker**
- [ ] **W1D4-3 — Deterministic mock-SMS worker**

### Day 5 — Recovery (M1)

- [ ] **W1D5-1 — Five-attempt retry classification**
- [ ] **W1D5-2 — DLQ storage and operator retry**
- [ ] **W1D5-3 — Worker-kill acceptance test**
  - Done when: restart leaves zero lost or permanently non-terminal deliveries.

## Week 2 — Experience and operations

- [ ] **W2D1-1 — Race-safe digest batches**
- [ ] **W2D1-2 — Digest flush worker**
- [ ] **W2D2-1 — User-scoped inbox REST**
- [ ] **W2D2-2 — Authenticated WebSocket gateway (M2)**
- [ ] **W2D3-1 — Packable React/vanilla widget**
- [ ] **W2D3-2 — Accessible neutral demo host**
- [ ] **W2D3-3 — Sanitized public dashboard**
- [ ] **W2D4-1 — Health, readiness, metrics, shutdown**
- [ ] **W2D4-2 — Images and Compose topology**
- [ ] **W2D4-3 — CI integration and browser suites (M3)**
- [ ] **W2D5-1 — Controlled reliability and throughput evidence**
- [ ] **W2D5-2 — Production deployment**
- [ ] **W2D5-3 — Evidence-backed release documentation (M4)**
