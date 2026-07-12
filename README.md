# NotifyHub

NotifyHub is an intentionally engineered multi-channel notification service. The repository is currently at its governance milestone; product code is built one verified task at a time.

[Implementation plan](docs/IMPLEMENTATION_PLAN.md) · [Milestones](docs/MILESTONES.md) · [Progress](docs/PROGRESS.md) · [Engineering document](docs/notifyhub-engineering-doc.md)

## Status

No product milestone is claimed yet. The first unchecked item in the implementation plan is the only active task. Setup and integration commands will be added only when their corresponding tasks pass verification.

The intended service accepts one authenticated product event and routes it to email, in-app inbox, and mock SMS while respecting preferences, quiet hours, digests, bounded retries, and an append-only delivery trail.

## Verification

Run `scripts/verify.ps1` on Windows or `scripts/verify.sh` on Linux. Verification grows with each task. Performance and deployment claims remain absent until reproducible evidence exists.

## License

MIT
