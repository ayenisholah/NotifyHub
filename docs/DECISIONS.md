# Decision Log

## D-001 — Ordered task execution

- Status: accepted
- Decision: execute the plan from the first unchecked task, one verified task at a time.
- Rationale: small diffs make review, verification, and recovery explicit.

## D-002 — Product stack

- Status: accepted
- Decision: Node.js 22, npm workspaces, strict TypeScript, Express, Zod, Prisma/PostgreSQL, BullMQ/Redis, React/Vite, raw WebSockets, Pino, and Prometheus.
- Rationale: this is the binding product stack.

## D-003 — Honest public boundary

- Status: accepted
- Decision: public reads contain synthetic summaries only; mutations require an operator key; measurements require raw evidence.
- Rationale: the public demo must not leak recipient/provider data or imply unverified operation.

## D-004 — BullMQ-safe queue names

- Status: accepted
- Decision: use `send-email`, `send-sms`, and `send-inapp` as the runtime channel queue names.
- Rationale: BullMQ 5 rejects colons in queue names, so the engineering document's conceptual `send:*` labels cannot be used verbatim.

## D-005 — Per-process operations and browser origin policy

- Status: accepted
- Decision: every deployable process owns health, readiness, metrics, structured logging, and graceful shutdown; browser WebSocket origins use an explicit production allowlist while origin-less non-browser clients remain supported.
- Rationale: Compose can supervise and scrape each isolated process directly, while exact origin checks protect browser tokens without treating the advisory `Origin` header as non-browser authentication.
