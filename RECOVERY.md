# Source recovery — 2026-10-01

This repository starts a new, honest Git history from a preserved older source-only snapshot. The original Git history and latest previously reported commit `683ccdd` are not available. The surviving snapshot declares an earlier `a497382` milestone in documentation, but has no Git metadata proving that identity.

Existing validation documents are historical evidence only. They do not certify this reconstructed tree. New verification and rebuilt features will be recorded below. The pinned Morphz Runtime remains unchanged. No real-model, paid-service, graphical-device, or production acceptance is implied.

## Reconstruction acceptance ledger

- Baseline: preserved source copied without dependencies, runtime state, or credentials; new Git root commit
- Baseline fresh validation passed: Node syntax checks, strict TypeScript, and 556 aggregate tests (551 passed, 5 intentionally skipped). Logs were rerun on the surviving baseline; prior 695-pass claims were not reused
- Baseline actual Runtime stream/reconnect test passed: unchanged official v0.1.3, one deterministic loopback provider call, zero paid calls. This verifies BFF/service reconnect, not a Runtime-process restart
- Pending: task details, authored text/Markdown/CSV versions and native provenance
- Pending: exact wait responses, Runtime outage/restart recovery
- Pending: bounded history pagination and durable retry/control recovery
- Pending: remote persistence verification by coordinating parent

This is a reconstruction, not a recovery of the original commits. Historical status statements in other documents must be interpreted accordingly until superseded here.

## Surviving source patches

Original frontend patch scripts also survived separately for task detail, generated documents, ordinary-submit identity, exact waits, history paging, approvals and fresh task-control review. They were replayed as source evidence, not represented as original Git history. Partial-replay defects require fresh review and tests before the reconstructed features can be certified.

## Reconstructed core checkpoint — 2026-10-01

Implemented task details/progress/results/resources, product-authored UTF-8 document versions, exact wait responses, bounded chat history, exact command lookup, and durable task/approval retry controls. Original frontend source patches were repaired with fresh regressions rather than assumed correct.

Fresh merged validation: 623 tests = 618 passed + 5 skipped, zero failures; strict types and syntax passed. Actual unchanged Runtime core journey passed with 11 local scripted calls, zero paid calls, two exact waits, two immutable document versions, two BFF restarts and one graceful Runtime restart. Detailed scope and non-claims are in docs/VALIDATION_CURRENT.md.

Baseline remote persistence was verified at commit `6af39b06d74ceefeca21f65d272a9e48f33529d4`, exact Git tree `191f7f2026eef28112b5963b0a973cf76b1ab918`, equal to local recovery root `6ee3f6dbbaae39236863d3268bc7fcb1daf48e0d`. Connector-created remote commit metadata differs; this mapping is intentional and does not recreate original history. New core publication is pending verification.

Remaining independent work: focused task-provenance review, bounded receipt-storage regressions and final exact-commit rerun. Remaining external acceptance gates: securely configured and explicitly budgeted real-model test, real graphical host/device acceptance. Voice stays deferred.
