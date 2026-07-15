# Milestones

| Gate   | Criterion                                                                                            | If missed                                                       |
| ------ | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **M0** | Governance scaffold committed and verification green                                                 | Stop before product code                                        |
| **M1** | Idempotent email + in-app pipeline; preferences, quiet hours, retry, DLQ, and worker-kill tests pass | Email-only degraded MVP allowed; never cut idempotency/recovery |
| **M2** | User-isolated REST and authenticated realtime pass integration tests                                 | Polling may ship temporarily                                    |
| **M3** | Widget, demo, dashboard, Compose, observability, integration, and browser checks pass                | Cut polish, never isolation or sanitation                       |
| **M4** | Controlled evidence recorded and synthetic demo deployed with backup/rollback guidance               | Publish without unverified claims                               |

## Current status

M0, M1, and M2 passed on 2026-07-12. M3 passed its complete integration, Compose, Chromium, and worker-restart gate on 2026-07-14. W2D5-1 recorded controlled evidence and W2D5-2 completed the first unattended production deployment on 2026-07-14. W2D5-3 published the evidence-backed `v0.1.0` release from a fully verified production revision on 2026-07-15 and closed M4. External Upwork publication was explicitly waived after the release media were prepared; no public portfolio-entry claim is made.
