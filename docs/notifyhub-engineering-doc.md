# NotifyHub — Engineering Document

**Multi-channel notification service — email, push, mock SMS & real-time in-app inbox**

| | |
|---|---|
| **Status** | Draft v1.0 |
| **Author** | You (solo build) |
| **Created** | 2026-07-10 |
| **Target duration** | 2 weeks (MVP shippable at end of week 1) |
| **Parent doc** | `my-portfolio-projects.md` → Project 4 (NotifyHub) |
| **Build order** | #3 — after PulseWS and SyncPad (most commercially relatable) |
| **Repo (planned)** | `notifyhub/` — TypeScript API + workers + React inbox widget |

---

## Table of contents

1. [Concept & problem statement](#1-concept--problem-statement)
2. [Goals and non-goals](#2-goals-and-non-goals)
3. [Users and use cases](#3-users-and-use-cases)
4. [Requirements](#4-requirements)
5. [System architecture](#5-system-architecture)
6. [Detailed design](#6-detailed-design)
7. [Technology decisions](#7-technology-decisions)
8. [UI/UX design + AI design prompts](#8-uiux-design--ai-design-prompts)
9. [Project plan & milestones](#9-project-plan--milestones)
10. [MVP definition](#10-mvp-definition)
11. [Testing & verification strategy](#11-testing--verification-strategy)
12. [Deployment & operations](#12-deployment--operations)
13. [Risks & mitigations](#13-risks--mitigations)
14. [Definition of done & acceptance tests](#14-definition-of-done--acceptance-tests)
15. [Future work](#15-future-work)
16. [Appendix](#16-appendix)

---

## 1. Concept & problem statement

### The idea in one sentence

One `POST /v1/notify` call fans a notification out to email, push, and a real-time in-app inbox — with per-user preferences, quiet hours, digest batching, retries with a dead-letter queue, and a full delivery log.

### The problem

Every product eventually rebuilds the same notification plumbing: "user X should hear about event Y" turns into template rendering, provider SDKs (SendGrid, Twilio, FCM), retry logic when providers flake, per-user opt-outs, "don't wake me at 3am" rules, batching so five comments become one email instead of five, and a delivery log for the support team asking "did the user actually get it?" Teams write this ad hoc, scattered across the codebase, and it breaks in every one of those dimensions. Commercial products (Knock, Courier, Novu) exist precisely because this plumbing is generic.

NotifyHub is that plumbing built properly once: a single ingestion API, a Postgres-backed pipeline through BullMQ queues, pluggable channel providers behind one interface, and a real-time in-app inbox widget — the whole lifecycle observable from `queued` to `sent`/`failed`.

### Why this is a strong portfolio piece

- The **most commercially relatable** of the five (parent doc's assessment): every client with a product has felt this pain; the proposal writes itself.
- It demonstrates the async-backend toolkit clients actually hire for: job queues, retries/backoff, DLQs, idempotency, transactional state machines, provider abstraction.
- The kill-a-worker-mid-batch demo (jobs retry and complete, poison messages land in the DLQ) is a reliability story most portfolios can't show.
- The in-app inbox widget over WebSockets ties it back to the real-time positioning of the whole portfolio.

---

## 2. Goals and non-goals

### Goals (binding — from the build spec)

| # | Goal |
|---|---|
| G1 | `POST /v1/notify` — `{userId, event, payload}` with idempotency keys |
| G2 | Per-event, per-channel Handlebars templates stored in Postgres |
| G3 | Channel workers via BullMQ (Redis): **email + in-app required**; one more (FCM web push or mock SMS) optional |
| G4 | Provider abstraction `interface Provider { send(msg): Result }` — Resend/SendGrid for email, mock SMS (the abstraction is the point, not Twilio spend) |
| G5 | Per-user channel preferences + quiet hours |
| G6 | Digest batching: N events within X minutes collapse into one message |
| G7 | Retries with exponential backoff + dead-letter queue |
| G8 | Delivery log per notification (queued → sent → failed) + minimal status dashboard page |
| G9 | In-app inbox: embeddable React widget over WebSocket — live updates, unread counts, mark-as-read |
| G10 | Throughput seed test demonstrating the "50k+/day"-class claim with a **measured** number |

### Non-goals (cut ruthlessly — also binding)

| # | Non-goal | Why it's cut |
|---|---|---|
| N1 | Multi-tenancy / orgs | Single API key; tenancy is a rewrite-level concern, not a demo concern |
| N2 | Visual workflow builder | That's Novu's moat, not a 2-week build; the pipeline is code/config |
| N3 | Analytics beyond the delivery log | Open/click tracking needs provider webhooks + pixel plumbing — future work |
| N4 | Real SMS spend | Mock provider implements the same interface; the abstraction is what's demonstrated |
| N5 | Template editing UI | Templates are seeded rows / managed by SQL; a CRUD UI adds nothing to the story |

> **Scope rule:** anything not in the Goals table goes to [§15 Future work](#15-future-work) and does not get built.

---

## 3. Users and use cases

### Primary audience (honest framing)

A **portfolio project**. The "users" are (a) you running the curl-to-inbox demo, (b) Upwork clients whose products send email/push and who recognize this exact pain, (c) developers reading the repo. Optimize for the one-curl demo and the worker-kill reliability demo.

### User stories

| ID | Story | Priority |
|---|---|---|
| US1 | As an integrating developer, one authenticated `POST /v1/notify` triggers an email AND a live in-app inbox message | Must |
| US2 | As an integrating developer, retrying the same request with the same idempotency key does not double-send | Must |
| US3 | As an end user, I mute the email channel for `comment.created` and only the in-app message arrives | Must |
| US4 | As an end user with quiet hours 22:00–08:00, a 23:00 notification email arrives at 08:00 (in-app still lands immediately) | Should |
| US5 | As an end user receiving 5 comments in 10 minutes, I get one digest email ("5 new comments"), not five | Must |
| US6 | As an operator, when the email provider 500s, deliveries retry with backoff and succeed; a permanently failing job lands in the DLQ where I can inspect and retry it | Must |
| US7 | As a support engineer, I open the dashboard, find the notification, and see its full per-channel delivery timeline | Must |
| US8 | As a frontend dev, I drop `<NotifyHubInbox userToken={...}/>` into my app and get a bell with a live unread badge and a mark-as-read inbox | Must |

### Demo script (design target)

The 3-minute demo: open the demo app (inbox widget in the corner) + dashboard side by side → run one curl → bell badge ticks to 1 in real time AND the email arrives (Resend dashboard/mailbox on screen) → dashboard shows the delivery timeline `queued → sent` per channel → run the digest seed (5 events) → one collapsed email, five inbox items → `docker compose kill worker-email` mid-seed → restart it → dashboard shows retries completing, nothing lost → point at the DLQ page with one poison message and click retry.

---

## 4. Requirements

### 4.1 Functional requirements

| ID | Requirement | Priority | Acceptance criterion |
|---|---|---|---|
| FR1 | `POST /v1/notify` `{userId, event, payload, idempotencyKey?}`, bearer-key auth, zod-validated → `202 {notificationId}` | Must | Valid request accepted < 50 ms (enqueue only); invalid → 422 with field errors |
| FR2 | Idempotency: unique `(idempotency_key)`; replays return the original `notificationId` with `200`, no re-processing | Must | Double-curl test produces one email |
| FR3 | Router stage: resolve user prefs + template existence per channel → create `delivery` rows (`queued`) → enqueue channel jobs. Unknown event or no templates → notification marked `no_op` with reason | Must | Every accepted notification reaches a terminal, explainable state |
| FR4 | Preferences: per-user per-channel per-event-category opt-in/out + quiet-hours window (with timezone); evaluation order documented (§6.4) | Must | US3/US4 scenarios pass as automated tests |
| FR5 | Digest batching: events flagged digestible open/join a per-`(user, event, channel)` batch window (default 10 min); on window close, one digest job renders all collected items | Must | 5 seeded events → 1 email whose body lists 5 items |
| FR6 | Handlebars templates in Postgres: `(event, channel, locale='en')` → subject/body(+html); rendered with `{user, payload, items[]}` (items for digests); missing variables render empty with a logged warning | Must | Template round-trip tests |
| FR7 | Email worker → provider abstraction (Resend default; SendGrid impl to prove pluggability; mailpit in dev); mock SMS worker (logs + delivery row, configurable failure rate for demos) | Must | Swapping provider = config change only |
| FR8 | In-app worker: insert `inbox_message` + publish to the WS gateway → connected widgets receive it live | Must | Curl-to-badge latency < 1 s locally |
| FR9 | Retries: BullMQ `attempts: 5`, exponential backoff (1s base, jitter); exhausted → job moved to DLQ queue + delivery marked `failed` with `last_error` | Must | Provider stub failing 3× then succeeding → delivery `sent`, `attempts: 4` |
| FR10 | DLQ: listable via dashboard + `POST /v1/dlq/:jobId/retry`; poison messages (validation-failed payloads) parked, never infinite-looped | Must | Kill-worker demo (US6) reproducible |
| FR11 | Delivery log: append-only `delivery_events` (`queued`, `processing`, `sent`, `retrying`, `failed`, `dlq`) with timestamps + provider message id | Must | Dashboard timeline renders the full lifecycle |
| FR12 | Dashboard (single page): recent notifications w/ per-channel status chips, notification detail timeline, DLQ list + retry, live counters | Must | The thumbnail source (with the widget) |
| FR13 | Inbox widget (embeddable React): bell + unread badge, panel list, mark-as-read (one + all), WS live updates with polling fallback; auth via short-lived signed user token from the host app | Must | `npm pack`-able; demo host app in the repo |
| FR14 | Widget REST endpoints: `GET /v1/inbox?cursor=`, `POST /v1/inbox/:id/read`, `POST /v1/inbox/read-all` | Must | Cursor pagination correct across reads |

### 4.2 Non-functional requirements

| ID | Requirement | Target | How measured |
|---|---|---|---|
| NFR1 | Ingestion latency (`POST /v1/notify` → 202) | p95 < 50 ms (enqueue-only design) | autocannon during seed run |
| NFR2 | Throughput | 50k notifications/day-equivalent target (~35/min sustained is trivial; measure the real ceiling: seed 10k, record notifications/min end-to-end) — **replace the "50k+/day" claim with measured** | Seed script + delivery-log timestamps |
| NFR3 | Curl-to-inbox-badge latency | < 1 s local | Demo instrumentation |
| NFR4 | Reliability | Zero lost notifications across worker kill/restart; at-least-once delivery with idempotent side effects | Kill-test during seed |
| NFR5 | Consistency | Every notification reaches a terminal state (`sent`/`failed`/`no_op`) — no zombies | Sweep query in tests |
| NFR6 | Security | API key for ingestion; signed short-lived user tokens for widget/WS (widget can only read its own user's inbox); secrets in env | Review + negative tests |
| NFR7 | Operability | One `docker compose up` (api, workers, Postgres, Redis, mailpit, demo app); health endpoints; pino structured logs w/ notificationId correlation | Manual |

---

## 5. System architecture

### 5.1 Topology

```
Client app ──POST /v1/notify──►┌────────────────────────────┐
                               │ API (Express + zod)        │
Dashboard ◄────────────────────│  auth · idempotency ·      │
                               │  insert notification ·     │
Inbox widget ◄──WS + REST──────│  enqueue "route" job ·     │
      ▲                        │  WS gateway (in-app feed)  │
      │                        └──────────┬─────────────────┘
      │                                   │            ┌──────────────┐
      │                            BullMQ (Redis)      │  Postgres    │
      │                                   │            │ notifications│
      │             ┌─────────────────────┼──────────┐ │ deliveries   │
      │             ▼                     ▼          ▼ │ delivery_    │
      │      ┌────────────┐      ┌────────────┐ ┌──────┤   events     │
      │      │ router     │      │ digest     │ │ DLQ  │ templates    │
      │      │ worker     │      │ scheduler  │ └──────┤ preferences  │
      │      └─────┬──────┘      └─────┬──────┘        │ inbox_msgs   │
      │            ▼ per-channel jobs  ▼               └──────────────┘
      │   ┌─────────────┬──────────────┬─────────────┐
      │   │ email worker│ sms worker   │ in-app      │
      │   │ Resend/     │ (mock        │ worker ─────┼──► Redis pub/sub ──► WS gateway
      │   │ SendGrid/   │  provider)   │ (Postgres + │
      │   │ mailpit     │              │  publish)   │
      └───┴─────────────┴──────────────┴─────────────┘
```

### 5.2 Components

| Component | Responsibility | Tech |
|---|---|---|
| **API service** | Ingestion, idempotency, widget REST, dashboard data, WS gateway | Express + zod, `ws` |
| **Router worker** | Prefs + quiet hours + digest decision → fan out per-channel delivery jobs | BullMQ worker |
| **Channel workers** | Render template → `provider.send()` → delivery state transitions | BullMQ workers (separate processes) |
| **Digest scheduler** | Batch windows via BullMQ delayed jobs; flush → digest render job | BullMQ delayed jobs + Postgres batch rows |
| **Provider layer** | `Provider` interface: Resend, SendGrid, mailpit (dev SMTP), MockSms | plain TS classes, config-selected |
| **WS gateway** | Widget connections, user-token auth, per-user rooms; fed by Redis pub/sub from the in-app worker | `ws` inside the API process |
| **Postgres** | Source of truth: notifications, deliveries, events, templates, preferences, inbox, digest batches | Prisma (or Drizzle) |
| **Dashboard** | Status page + DLQ ops | small React page served by API |
| **Inbox widget** | Embeddable bell/panel | React, packaged separately |

### 5.3 Data flow (one notification, happy path)

1. `POST /v1/notify` → auth, validate, idempotency check → insert `notification` (status `accepted`) → enqueue `route` job → `202`.
2. Router worker: load user + prefs → for each candidate channel with a template: quiet hours? → schedule delayed; digestible? → join/open batch; else → insert `delivery` (`queued`) + enqueue channel job. No channels → `no_op`.
3. Email worker: mark `processing` → render Handlebars → `provider.send()` → `sent` + provider message id (or throw → BullMQ retry → eventually `failed` + DLQ).
4. In-app worker: insert `inbox_message` → publish `{userId, message}` on Redis → WS gateway pushes to that user's sockets → badge increments.
5. Every transition appends a `delivery_events` row — the dashboard timeline reads only this table.

---

## 6. Detailed design

### 6.1 REST API

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /v1/notify` | API key | Ingest `{userId, event, payload, idempotencyKey?}` |
| `GET /v1/notifications/:id` | API key | Status + deliveries + event timeline |
| `GET /v1/notifications?status=&cursor=` | API key | Dashboard list |
| `PUT /v1/users/:id/preferences` | API key | Upsert channel/category prefs + quiet hours |
| `POST /v1/users/:id/token` | API key | Mint short-lived signed widget token (HMAC, 1 h) |
| `GET /v1/inbox?cursor=` · `POST /v1/inbox/:id/read` · `POST /v1/inbox/read-all` | user token | Widget |
| `GET /v1/dlq` · `POST /v1/dlq/:jobId/retry` | API key | DLQ ops |
| `GET /healthz` · `GET /metrics` | — | Ops |

Idempotency: `idempotency_key` unique index; on conflict return the existing row (`200`, same body shape). Keys optional but recommended; documented in the README's integration section.

### 6.2 Postgres schema (core tables)

```sql
users            (id, email, phone, timezone, created_at)
preferences      (user_id, channel, category, enabled, PK(user_id, channel, category))
quiet_hours      (user_id PK, start_minute, end_minute)          -- minutes-of-day, user TZ
templates        (id, event, channel, locale, subject, body, body_html, digest_body, updated_at,
                  UNIQUE(event, channel, locale))
notifications    (id uuid, user_id, event, payload jsonb, idempotency_key UNIQUE NULLS DISTINCT,
                  status: accepted|routed|no_op, created_at)
deliveries       (id uuid, notification_id FK, channel, provider,
                  status: queued|processing|sent|retrying|failed|dlq|scheduled,
                  attempts, last_error, provider_message_id, scheduled_for, created_at, updated_at)
delivery_events  (id bigserial, delivery_id FK, status, detail jsonb, created_at)   -- append-only
digest_batches   (id uuid, user_id, event, channel, window_ends_at,
                  status: open|flushed, UNIQUE(user_id, event, channel) WHERE status='open')
digest_items     (batch_id FK, notification_id FK, created_at)
inbox_messages   (id uuid, user_id, notification_id FK, title, body, read_at, created_at)
                  -- index (user_id, created_at DESC); partial index unread
```

State machine rule: `deliveries.status` transitions only forward (`queued → processing → sent | retrying → … → failed → dlq`), enforced in one `transitionDelivery()` helper that also appends the `delivery_events` row in the same transaction — a single choke point makes NFR5 provable.

### 6.3 BullMQ pipeline

- **Queues**: `route`, `send:email`, `send:sms`, `send:inapp`, `digest:flush`, `dlq`.
- Job payloads carry ids only (`{deliveryId}` / `{notificationId}`) — workers re-read Postgres truth; queue payloads never drift from the DB.
- **Retry policy**: `attempts: 5, backoff: {type: 'exponential', delay: 1000}` (+ per-attempt jitter). Provider errors are classified: `RetryableError` (timeouts, 5xx, rate limits) → throw and let BullMQ retry; `PermanentError` (invalid address, template render failure) → straight to `failed` + DLQ, no pointless retries. The classification lives in the provider layer.
- **DLQ**: on `failed` event (attempts exhausted) or `PermanentError`, add a job to the `dlq` queue with the original payload + error chain; mark delivery `dlq`. Dashboard retry re-enqueues to the origin queue with fresh attempts.
- **At-least-once discipline**: a worker crash after `provider.send()` but before the DB write re-runs the job. Mitigation: mark `processing` + write an attempt row *before* sending, and pass an idempotency hint to providers that support it (Resend honors an `Idempotency-Key` header); document the residual duplicate window honestly in the README — knowing where exactly-once breaks *is* the interview answer.
- **Worker processes**: each channel worker is a separate Node process (own Compose service) so the kill-demo (`docker compose kill worker-email`) is real process death, not an in-process trick.

### 6.4 Preference & quiet-hours evaluation (documented precedence)

Order of evaluation in the router, first match wins per channel:

1. **No template** for `(event, channel)` → channel skipped (`no_op` reason recorded).
2. **Preference off** for `(channel, category)` (category = event prefix, e.g. `comment.*`; default **on** when no row) → skipped, reason `pref_disabled`.
3. **Critical override**: payload `{critical: true}` bypasses quiet hours and digests (think password-reset), never preferences.
4. **Quiet hours** (email/SMS only — in-app always lands silently): if `now` in the user-TZ window → delivery `scheduled` with `scheduled_for = window end`, enqueued as a BullMQ delayed job. Windows crossing midnight handled in minutes-of-day math (unit-tested; DST cases documented as approximated).
5. **Digest** (per-template flag): join the open batch or open one (§6.5).
6. Otherwise → immediate send.

Every skip/deferral is recorded in `delivery_events.detail` — "why didn't the user get it?" is always answerable from the dashboard.

### 6.5 Digest batching

- First digestible event: insert `digest_batches` row (`open`, `window_ends_at = now + 10 min` — per-template configurable) + a BullMQ **delayed job** `digest:flush {batchId}` with exactly that delay; subsequent events insert `digest_items` into the open batch (the partial unique index makes open-batch lookup race-safe: on conflict, join the winner).
- Flush job: mark batch `flushed` (transactional, idempotent — a re-run sees `flushed` and exits), load items, render the template's `digest_body` with `{items[], count}`, create one delivery, send.
- Edge: batch of 1 renders the digest body with one item — simpler than switching templates, and correct.
- In-app messages are **not** digested (each event lands in the inbox; digesting applies to interruptive channels) — a product decision, documented.

### 6.6 Provider abstraction

```ts
interface Provider {
  readonly channel: 'email' | 'sms' | 'push';
  readonly name: string;                       // 'resend' | 'sendgrid' | 'mailpit' | 'mock-sms'
  send(msg: RenderedMessage): Promise<{ providerMessageId: string }>;
  // throws RetryableError | PermanentError (classification lives here)
}
```

- Config selects the active provider per channel (`EMAIL_PROVIDER=resend`); a registry maps names → instances.
- **Resend** (default: generous free tier, clean API, idempotency header), **SendGrid** (second impl proves pluggability), **mailpit** (SMTP catcher in Compose — dev/demo email lands in a local web UI, so the demo needs no real inbox), **MockSms** (logs + fake ids + `MOCK_SMS_FAILURE_RATE` env for demoing retries/DLQ on stage).
- Provider unit tests run against recorded fixtures; no live provider calls in CI.

### 6.7 In-app inbox & WS gateway

- Widget auth: host app calls `POST /v1/users/:id/token` server-side → short-lived HMAC token → widget connects `wss://host/ws/inbox?token=…`. Gateway verifies, joins the socket to a per-user room. A user token can only ever read its own inbox (NFR6).
- In-app worker → `PUBLISH notifyhub:inbox:<userId>` on Redis → gateway (subscribed via pattern or a single channel with userId in the envelope) pushes `{type:'message', message}` and `{type:'unread', count}`.
- Widget: bell + badge (unread count from `GET /v1/inbox` on mount, then WS deltas), panel with cursor pagination, optimistic mark-as-read, reconnect with backoff, and a 30 s polling fallback when WS is unavailable (embeddable widgets must degrade).
- Packaging: separate `widget/` package built with Vite lib mode (`NotifyHubInbox` React export + a vanilla `mount()` wrapper); the repo's demo host app embeds it — that page is half of the thumbnail.

### 6.8 Throughput seed test

`scripts/seed.ts`: N synthetic users with mixed prefs/quiet-hours/digest settings → fire 10k `POST /v1/notify` at a controlled rate (mailpit absorbing email) → poll until all terminal → report: accepted/s at the API, end-to-end notifications/min through the pipeline, per-channel counts, retry counts (with `MOCK_SMS_FAILURE_RATE=0.05`), zero-zombie check (NFR5 sweep). Output lands in `docs/measurements.md`; the sustained notifications/min × 1440 gives the honest "per day" figure for the portfolio copy.

---

## 7. Technology decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Framework | **Express + zod** | NestJS (spec allows either), Fastify | Small surface; zod end-to-end matches PulseWS; NestJS's DI ceremony adds nothing at this size |
| Queue | **BullMQ** | RabbitMQ, SQS, pg-boss | Spec names it; delayed jobs give digests + quiet-hours scheduling for free; Redis already in the portfolio stack |
| ORM | **Prisma** | Drizzle (spec allows), knex | Fastest schema→working-code path; migrations story is clean; swap-cost documented as low |
| Templates | Handlebars | MJML, react-email, liquid | Spec names it; logic-less is a feature for user-supplied-ish templates. MJML noted as future work for pretty email |
| Email provider | **Resend** (+ SendGrid impl + mailpit dev) | SendGrid-only, SES | Free tier + idempotency header; two real impls prove G4's pluggability claim |
| Push channel | **Deferred to optional** (mock SMS is the required third demo of the abstraction) | FCM web push now | FCM adds service-worker + VAPID plumbing; the spec marks it optional — take the option only if Week 2 has slack |
| WS layer | `ws` (raw) | Socket.IO | One event type each way; Socket.IO buys nothing but weight. Polling fallback is hand-rolled (30 s) for widget resilience |
| Widget build | Vite lib mode, React peer dep | iframe embed | npm-installable component is what integrators expect; iframe isolation noted as future work |
| Dashboard | Single React page served by the API | Grafana-only, Retool | The delivery timeline *is* the product story; Grafana can't render it. Kept to one page (N-guard) |
| Dev email | mailpit in Compose | real inboxes | Demo determinism; screenshots without leaking a personal inbox |

---

## 8. UI/UX design + AI design prompts

### 8.1 Surfaces

1. **Inbox widget** — bell + unread badge; panel (~360 px) with notification rows (title, body snippet, relative time, unread dot), "mark all read", empty state. Must look at home inside *someone else's* product: neutral styling, CSS-variable theme hooks.
2. **Status dashboard** — the operator view and thumbnail: header counters (sent today, in flight, failed, DLQ), recent-notifications table with per-channel status chips (`email ✓ · in-app ✓ · sms ↻retry`), detail drawer with the delivery timeline, DLQ tab with retry buttons.
3. **Demo host app** — a fake SaaS page ("Acme Projects") with the widget mounted, so screenshots show the widget *in context*.

### 8.2 AI design prompts (ready to paste)

**Prompt A — widget + dashboard mockup (paste into v0.dev, Lovable, or Figma Make):**

```
Design two related surfaces for "NotifyHub", a developer notification service.

1. An embeddable in-app inbox widget shown inside a neutral fake SaaS app
   ("Acme Projects", light theme): a bell icon in the app header with a red
   unread badge "3"; below it an open dropdown panel (360px wide) titled
   "Notifications" with a "Mark all read" text button, containing 5 rows —
   each with a small colored channel icon, bold title ("New comment on
   Roadmap"), one-line body snippet, relative timestamp ("2m ago"), and a blue
   unread dot on the first three. Last row read (muted). Clean, product-neutral
   styling that would blend into any SaaS app; subtle shadow; empty-state
   variant too ("You're all caught up ✓").

2. An operator status dashboard, dark theme (#0f1216), emerald accent
   (#34d399), Inter + JetBrains Mono for data. Top: four stat cards —
   "Sent today 12,482", "In flight 37", "Failed 12", "DLQ 3 ⚠". Middle: a
   table of recent notifications: time, user, event (monospace chip like
   "comment.created"), and a channels column with per-channel status chips:
   green check "email", green check "in-app", amber spinner "sms retry 2/5",
   red "failed". One row expanded into a detail drawer showing a vertical
   delivery timeline: "queued 12:01:03.2 → processing 12:01:03.4 →
   retrying (SMTP 451) 12:01:04.1 → sent 12:01:09.8 · provider id re_8f2…".
   A "Dead letter" tab badge showing "3".

Output as static React + Tailwind mockups with hardcoded plausible data.
```

**Prompt B — architecture diagram (paste into Eraser.io AI, or ask Claude/ChatGPT for Mermaid/Excalidraw):**

```
Create a left-to-right fan-out architecture diagram titled "NotifyHub —
multi-channel notification pipeline". Left: "Client app" box with an arrow
"POST /v1/notify {userId, event, payload} + idempotency key" into an "API
(Express + zod)" box. The API box connects down to a Postgres cylinder
(labeled: notifications, deliveries, delivery_events, templates, preferences,
inbox) and right into a Redis/BullMQ box labeled "queues: route · send:email ·
send:sms · send:inapp · digest:flush · DLQ". From the queue box, a "Router
worker" node branches (showing decision labels "prefs? quiet hours? digest?")
into three worker nodes: "Email worker → Resend/SendGrid (mailpit in dev)",
"SMS worker → mock provider", "In-app worker → Redis pub/sub → WS gateway →
Inbox widget (live badge)". Show a retry loop arrow on the email worker
labeled "exponential backoff ×5" and a dashed arrow to a small red box
"dead-letter queue". Bottom: a "Status dashboard" box reading from Postgres.
Style: dark background, emerald accent, monospace labels.
```

**Prompt C — brand/OG image (paste into Midjourney, Ideogram, or DALL-E):**

```
Minimal tech logo/social banner for "NotifyHub": one incoming line splitting
into four branch arrows (an abstract fan-out), the last branch ending in a
small bell mark, geometric flat vector, single emerald accent (#34d399) on
near-black, subtle dotted-queue pattern in the background, no gradients, no
photorealism, wide 1200x630 banner with the wordmark "NotifyHub" and subtitle
"one API call · every channel". --style raw
```

> **Note:** the Upwork **thumbnail** is the real screenshot — inbox widget open with the delivery dashboard behind it (per the capture checklist). Prompt C's output is for the GitHub social preview and README header.

### 8.3 Design acceptance

- [ ] Widget mockup iterated until it looks native inside the fake SaaS page; dashboard chips legible at thumbnail size
- [ ] Architecture diagram from Prompt B exported to `docs/architecture.png`, embedded in README
- [ ] OG image from Prompt C set as the GitHub social preview

---

## 9. Project plan & milestones

2 weeks, ~15–20 focused hours/week. Pipeline reliability first (Week 1 is entirely backend, per the parent spec); UI second.

### Week 1 — API + pipeline + email + reliability *(→ MVP)*

| Day | Work |
|---|---|
| 1 | Repo scaffold (TS monorepo: api/workers/widget/demo), Compose (Postgres, Redis, mailpit), Prisma schema + migrations + seed templates |
| 2 | `POST /v1/notify` (auth, zod, idempotency) + `transitionDelivery()` helper + router worker skeleton → in-app rows written (no WS yet) |
| 3 | Email worker: Handlebars render, `Provider` interface, mailpit + Resend impls, error classification |
| 4 | Retries/backoff + DLQ + dlq retry endpoint; `MOCK_SMS_FAILURE_RATE` mock provider; kill-worker test passes |
| 5 | Preferences + quiet hours (delayed jobs) with the §6.4 precedence tests. **Checkpoint = MVP (§10): one curl → email in mailpit + inbox row, retries provable** |

### Week 2 — digests, live inbox, dashboard, measure, publish

| Day | Work |
|---|---|
| 1 | Digest batches (open/join race-safe, delayed flush, digest render); seed demo for the 5→1 story |
| 2 | WS gateway + user tokens + Redis pub/sub; inbox REST (cursor, read, read-all) |
| 3 | Inbox widget (bell, panel, live updates, polling fallback) + demo host app; packaged via Vite lib mode |
| 4 | Dashboard page (counters, table, timeline drawer, DLQ tab); throughput seed run → record real numbers |
| 5 | Deploy (VPS Compose or Fly + Neon/Upstash), README (GIF → diagram → reliability writeup → quickstart), capture screenshots, update portfolio copy with measured throughput. Optional if ahead: FCM web push worker |

### Milestone gates

| Gate | Criterion | If missed |
|---|---|---|
| M1 (W1D4) | Kill-a-worker test: seed in flight, worker killed + restarted, all deliveries terminal, poison → DLQ | Stop and fix — reliability is the product; nothing downstream matters |
| M2 (end W1) | **MVP**: curl → email + inbox row; prefs + quiet hours enforced | Quiet hours may slip 1 day into W2; idempotency/retries may not |
| M3 (W2D3) | Live widget end-to-end (curl → badge < 1 s) | Ship polling-only widget, note WS as in-progress |
| M4 (end W2) | Deployed, measured, README, portfolio updated | Cut FCM (it's optional by spec) and the SendGrid second impl; never cut the measured-numbers step |

---

## 10. MVP definition

**MVP = the smallest thing that proves the thesis:** one API call reliably fans out to two channels with observable delivery state, surviving worker failure.

**In the MVP (end of Week 1):**
- `POST /v1/notify` with idempotency
- Router + email worker (mailpit/Resend) + in-app rows (DB only)
- Preferences + quiet hours
- Retries, backoff, DLQ — kill-test green
- Delivery log queryable via `GET /v1/notifications/:id`

**Explicitly *not* in the MVP (Week 2):** digests, WS live inbox, widget, dashboard UI, throughput numbers, deployment.

**Blessed degraded MVP** (if Week 1 slips): email channel only, prefs deferred — ingestion + render + send + retry + DLQ is still a complete reliability story.

---

## 11. Testing & verification strategy

| Layer | What | How |
|---|---|---|
| Unit | zod schemas, idempotency conflict path, quiet-hours minutes-of-day math (incl. midnight-crossing), precedence table (§6.4) as table-driven tests, error classification, Handlebars render + digest render | Vitest |
| Integration (DB+queue) | Full pipeline against real Postgres + Redis (testcontainers): notify → terminal state; retry path (provider stub fails N times); DLQ + retry endpoint; digest open/join race (parallel inserts); delayed quiet-hours job | Vitest, serial suite |
| **Reliability** | Seed 500 in flight → `SIGKILL` email worker → restart → assert zero non-terminal deliveries and no duplicates beyond the documented window | Scripted (`scripts/kill-test.sh`), run in CI nightly + before demo |
| E2E | Playwright: demo app + widget — curl (via request fixture) → badge increments < 1 s; mark-as-read persists; dashboard timeline shows the run | Playwright against Compose |
| Throughput | §6.8 seed → `docs/measurements.md` | Manual on deploy box |
| Consistency sweep | Query for zombie states (non-terminal older than X) — asserted zero in every integration run | SQL helper |

CI: typecheck + unit + integration (testcontainers) on push; Playwright + kill-test nightly.

---

## 12. Deployment & operations

- **Demo deployment**: single VPS running the full Compose stack (api, 3 workers, Postgres, Redis, mailpit, demo app) behind Caddy TLS — the same Compose file as dev, which *is* the ops story: parity. (Alternative: Fly.io machines + Neon Postgres + Upstash Redis; choose whichever is cheaper to keep alive.)
- **Processes**: api + each worker as separate Compose services with health checks; `restart: unless-stopped`.
- **Config**: env-only (12-factor); `.env.example` committed; provider keys secret.
- **Observability**: pino JSON logs with `notificationId`/`deliveryId` on every line; `/metrics` (prom-client): queue depths (BullMQ getters), deliveries by status/channel, provider latency histogram, DLQ size. Optional Grafana panel for the README.
- **Migrations**: `prisma migrate deploy` on api start (single-node demo: acceptable; noted).
- **Data hygiene**: demo cron truncates data older than 7 days.

---

## 13. Risks & mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Distributed-state bugs (zombie deliveries, digest races) | High | High | Single `transitionDelivery()` choke point; race-safe partial unique index; zombie sweep asserted in every integration run |
| R2 | Double-sends around the send/DB-write boundary | Medium | Medium | Provider idempotency keys where supported; window documented honestly (§6.3) — the writeup is a feature |
| R3 | Email deliverability rabbit hole (SPF/DKIM) | Medium | Low | mailpit for all demos; Resend for the one real-email proof; deliverability explicitly out of story |
| R4 | Widget scope creep (theming, positioning, a11y polish) | Medium | Medium | Widget is bell+panel+read-state only; CSS variables and nothing more; N-list guards |
| R5 | FCM push eats Week 2 | Medium | Medium | Already demoted to optional (§7); mock SMS is the third-channel proof |
| R6 | Timezone/DST bugs in quiet hours | Medium | Low | Minutes-of-day + `Intl` TZ conversion, unit-tested; DST edge documented as approximated |
| R7 | 2-week estimate slips | Medium | Medium | Gates with pre-decided cuts; email-only degraded MVP pre-authorized |

---

## 14. Definition of done & acceptance tests

Ship when **all** pass (mirrors + extends the parent spec's DoD):

1. **One curl** triggers an email (visible in mailpit/Resend) AND a live in-app inbox update on the deployed demo.
2. **Kill-a-worker**: mid-seed worker kill + restart → all notifications reach terminal states, retries visible in the timeline, poison messages in the DLQ, DLQ retry works.
3. **Idempotency**: same key twice → one send, same `notificationId`.
4. **Preferences/quiet hours/digest**: US3, US4, US5 pass as automated tests and are reproducible in the demo.
5. **Widget**: embedded in the demo app — live badge, pagination, mark-as-read, WS-down polling fallback.
6. **Dashboard**: timeline + DLQ operations working; screenshot with the widget = thumbnail captured.
7. **Throughput measured** via the seed run, recorded in `docs/measurements.md` → replaces "50k+ notifications/day" in the portfolio copy.
8. **README**: demo GIF → architecture diagram → reliability writeup (at-least-once, DLQ, the documented duplicate window) → `docker compose up` quickstart → integration guide (curl + widget snippet).
9. **Portfolio entry updated** per the parent doc's publishing workflow (≤ 600 chars re-count, media uploaded).

---

## 15. Future work (explicitly deferred)

- FCM web push worker (the spec's optional channel) + real Twilio SMS behind the same interface
- Provider webhooks → delivery confirmations (delivered/bounced/opened) in the timeline (N3 today)
- Multi-tenancy: orgs, per-tenant keys/templates/rate limits
- Template management UI + MJML/react-email pretty templates
- Batch ingest endpoint + Kafka source
- Workflow steps (delay/branch sequences — the Novu direction)
- Widget iframe isolation + web-component build

---

## 16. Appendix

### 16.1 Planned repo layout

```
notifyhub/
├── package.json               # workspaces
├── packages/
│   ├── api/src/
│   │   ├── index.ts           # express boot, routes, WS gateway
│   │   ├── routes/            # notify, notifications, preferences, inbox, dlq, tokens
│   │   ├── gateway.ts         # ws rooms + redis subscribe
│   │   └── auth.ts            # api key + user tokens
│   ├── core/src/              # shared: prisma client, transitionDelivery(),
│   │   │                      #   queues.ts, precedence.ts, render.ts, providers/
│   │   └── providers/         # resend.ts sendgrid.ts mailpit.ts mock-sms.ts
│   ├── workers/src/           # router.ts, email.ts, sms.ts, inapp.ts, digest.ts
│   │                          #   (each with a bin entry = one Compose service)
│   ├── widget/src/            # NotifyHubInbox.tsx, mount.ts, styles.css (vite lib)
│   ├── dashboard/src/         # single-page React (served by api)
│   └── demo-app/              # fake SaaS page embedding the widget
├── prisma/                    # schema.prisma, migrations, seed.ts (templates/users)
├── scripts/                   # seed.ts (throughput), kill-test.sh
├── test/                      # vitest unit + integration, playwright e2e
├── deploy/                    # docker-compose.yml, Caddyfile, .env.example
└── docs/                      # this doc, architecture.png, measurements.md
```

### 16.2 Key package list

`express`, `zod`, `bullmq`, `ioredis`, `@prisma/client`, `handlebars`, `ws`, `pino`, `prom-client`, `resend`, `@sendgrid/mail`, `nodemailer` (mailpit SMTP), dev: `typescript`, `tsx`, `vitest`, `testcontainers`, `playwright`, `autocannon`.

### 16.3 Portfolio capture checklist (from the parent doc — do not skip)

- [ ] Screenshot: inbox widget open + delivery dashboard behind it → Upwork thumbnail
- [ ] Fan-out architecture diagram (Prompt B export) → Upwork media + README
- [ ] Measured throughput from the seed run → replaces "50k+ notifications/day" in the Part 1 description
- [ ] Re-count the edited description ≤ 600 chars before pasting
- [ ] Live demo link (demo app + dashboard) + GitHub repo link in the Upwork entry

### 16.4 Glossary

| Term | Meaning |
|---|---|
| **Fan-out** | One ingested event producing deliveries across multiple channels |
| **Idempotency key** | Client-supplied unique key making retried API calls safe (one logical notification) |
| **DLQ (dead-letter queue)** | Parking lot for jobs that exhausted retries or failed permanently; inspectable and retryable |
| **Digest** | Collapsing N events in a time window into one message per (user, event, channel) |
| **Quiet hours** | Per-user window during which interruptive channels are deferred, not dropped |
| **At-least-once** | Delivery semantic where retries may duplicate work; side effects must be idempotent |
| **Provider** | A concrete channel backend (Resend, SendGrid, mock SMS) behind the common `send()` interface |
| **Zombie** | A delivery stuck in a non-terminal state — the consistency bug NFR5 forbids |
