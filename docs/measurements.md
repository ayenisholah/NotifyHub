# NotifyHub controlled throughput measurement

Status: **PASS**

Measured: 2026-07-14T17:47:31.480Z

Commit: `a9795f1e6ed92ed4e99e70a17c0d6f18b1b6320e`

Run ID: `20260714t173441z-a9795f1-10k`

## Result

- 10,000 unique notifications accepted with 0 HTTP failures.
- Sustained ingestion: 199.96 notifications/second (p95 62.51 ms).
- End-to-end pipeline: 1328.99 notifications/minute, including the one-minute digest window.
- Mechanical daily projection: 1,913,747 notifications/day. This is a projection from the controlled run, not a production traffic claim.
- Retry transitions: 408; digest items: 1200; open digest batches: 0.
- Non-terminal queue jobs after convergence: 0.

| Channel | Sent | DLQ |
| ------- | ---: | --: |
| EMAIL   | 6848 |   0 |
| IN_APP  | 9500 |   0 |
| SMS     | 8000 |   0 |

## Method

An isolated Docker Compose project seeded 100 synthetic users across default, email opt-out, SMS opt-out, inactive quiet-hours, and all-opt-out cohorts. It submitted 10,000 deterministic requests at 200/second with 20% digest events, 5% critical events, Mailpit email delivery, and a 5% deterministic mock-SMS failure rate. The run passed only after all notifications reached ROUTED or NO_OP, every delivery reached SENT or DLQ, every digest flushed, queue work drained, and database/queue DLQ counts agreed.

Calibration used increasing request rates and selected the highest error-free rate meeting a 250 ms ingestion p95 ceiling. The measurement stack used separate containers, networks, volumes, image tag, host ports, and generated synthetic secrets; the production Compose project was not restarted or mutated.

## Evidence and limitations

- Raw machine-readable evidence: [`20260714t173441z-a9795f1-10k.json`](./evidence/20260714t173441z-a9795f1-10k.json)
- Independent 500-delivery SIGKILL recovery run: [GitHub Actions](https://github.com/ayenisholah/NotifyHub/actions/runs/29351464129)
- Production health before/after isolated load: true / true.
- Host: 4 logical CPUs, 7.1 GiB visible memory, linux/x64, Node v22.23.1.
- Synthetic providers and one isolated host do not establish hosted-provider latency, multi-host scalability, or a production SLO.
- The daily figure is the measured end-to-end notification rate multiplied by 1,440 minutes; no extrapolation beyond that arithmetic is implied.
