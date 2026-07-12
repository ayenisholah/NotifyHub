# Engineering specification

NotifyHub accepts a product event once, applies recipient preferences, and independently delivers it through email, in-app, and mock-SMS channels. The system prioritizes explainable state, bounded recovery, and strict user-token isolation.

## Invariants

- Persist a notification before enqueueing routing work.
- Record every delivery state transition in an append-only timeline.
- Apply preferences in order: global channel rule, event override, quiet-hours deferral, digest batching.
- Authenticate API writes with the integration key and inbox access with a one-hour user-scoped token.
- Expose only synthetic identifiers and payload key summaries through public operational reads.
- Retry transient channel failures five times; park exhausted work for explicit operator recovery.

## Delivery semantics

Queues provide at-least-once execution. Inbox insertion is unique by notification. Provider calls use the delivery ID as an idempotency key where supported. Email or SMS providers without effective idempotency can duplicate a send if the process exits after provider acceptance and before the terminal database transition.

## Out of scope

Multi-tenancy, real SMS, FCM, visual template editing, and provider webhook analytics are deferred.
