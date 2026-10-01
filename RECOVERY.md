# Source recovery — 2026-10-01

This repository starts a new, honest Git history from a preserved older source-only snapshot. The original Git history and latest previously reported commit `683ccdd` are not available. The surviving snapshot declares an earlier `a497382` milestone in documentation, but has no Git metadata proving that identity.

Existing validation documents are historical evidence only. They do not certify this reconstructed tree. New verification and rebuilt features will be recorded below. The pinned Morphz Runtime remains unchanged. No real-model, paid-service, graphical-device, or production acceptance is implied.

## Reconstruction acceptance ledger

- Baseline: preserved source copied without dependencies, runtime state, or credentials; new Git root commit
- Baseline fresh validation passed: Node syntax checks, strict TypeScript, and 556 aggregate tests (551 passed, 5 intentionally skipped). Logs were rerun on the surviving baseline; prior 695-pass claims were not reused
- Baseline actual Runtime stream/reconnect test passed: unchanged official v0.1.3, one deterministic loopback provider call, zero paid calls. This verifies BFF/service reconnect, not a Runtime-process restart
- Rebuilt and verified: task details, authored text/Markdown/CSV versions and native provenance
- Rebuilt and verified: exact wait responses, Runtime outage/restart recovery
- Rebuilt and verified: bounded history pagination and durable retry/control recovery
- Remote persistence verified for baseline and integrated-core checkpoint; final hardening publication is verified separately by exact Git tree hash

This is a reconstruction, not a recovery of the original commits. Historical status statements in other documents must be interpreted accordingly until superseded here.

## Surviving source patches

Original frontend patch scripts also survived separately for task detail, generated documents, ordinary-submit identity, exact waits, history paging, approvals and fresh task-control review. They were replayed as source evidence, not represented as original Git history. Partial-replay defects require fresh review and tests before the reconstructed features can be certified.

## Reconstructed core checkpoint — 2026-10-01

Implemented task details/progress/results/resources, product-authored UTF-8 document versions, exact wait responses, bounded chat history, exact command lookup, and durable task/approval retry controls. Original frontend source patches were repaired with fresh regressions rather than assumed correct.

Fresh merged validation: 623 tests = 618 passed + 5 skipped, zero failures; strict types and syntax passed. Actual unchanged Runtime core journey passed with 11 local scripted calls, zero paid calls, two exact waits, two immutable document versions, two BFF restarts and one graceful Runtime restart. Detailed scope and non-claims are in docs/VALIDATION_CURRENT.md.

Baseline remote persistence was verified at commit `6af39b06d74ceefeca21f65d272a9e48f33529d4`, exact Git tree `191f7f2026eef28112b5963b0a973cf76b1ab918`, equal to local recovery root `6ee3f6dbbaae39236863d3268bc7fcb1daf48e0d`. Connector-created remote commit metadata differs; this mapping is intentional and does not recreate original history. New core publication is pending verification.

The then-pending focused task-provenance review and bounded receipt-storage regressions are now complete; see final verification below. Remaining external acceptance gates: securely configured and explicitly budgeted real-model test, real graphical host/device acceptance. Voice stays deferred.

## Final core verification — 2026-10-01

- Aggregate 660 tests: 655 passed, 5 skipped, 0 failed; strict TypeScript, Node syntax and whitespace checks pass
- Frontend 136 VM tests; independent task-detail review 17 tests
- Native core recovery fixture: 12 scripted loopback calls, zero paid calls. Added actual accepted-but-response-lost admission recovery across Runtime restart, matching original receipt and one output per recovered chat
- Native registered-resource fixture: 2 scripted calls; live stream/reconnect fixture: 1 scripted call. Neither uses a paid or external model
- Exact native attribution, generation regression, stale approval precedence, bounded task lookup and later-independent control-chain recovery hardened after independent review
- Pinned Morphz source remains clean at `7e8f7d81f8b00fd45544d94d5b9a321214633df1`
- Graphical attempt was blocked by cloud-browser URL security policy before login. No screenshot, browser navigation, real-device or full-product acceptance is claimed

Remote integrated-core checkpoint `4b44059ddd193149675a04378668a01c5fc22538` was fetched and verified with exact tree `79044bd7b7bedab2dda6e0c188e2d3f88ae9a966`, matching local `867e191507b89742f4516ec0093be30aa73654ea`. Final hardening follows that checkpoint.

Local origin is configured as `https://github.com/shafreeck/opendots.git`. Local reconstruction history and connector-created remote ancestry differ; no tracking branch or force-push is configured. For future shared work, start from a separate clone of remote main, preserving this local recovery history and its explicit tree mappings.

The independent core coding/review work is complete at this boundary. External gates remain securely configured and explicitly budgeted real-model testing, an authorized graphical host/device, and separate deployment/account permissions. Experimental backup of the current schema remains unsupported and fail-closed; cross-session and arbitrary binary document import remain unsupported; voice stays deferred.
