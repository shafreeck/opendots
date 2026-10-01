# Reconstructed-tree validation

2026-10-01. This is fresh reconstruction evidence, not certification of the inaccessible historical `683ccdd` tree. Original history was not recovered. See [recovery ledger](../RECOVERY.md).

## Current checks

- Aggregate: 623 tests, 618 passed, 5 intentionally skipped, 0 failed
- Strict TypeScript, Node syntax checks and whitespace checks passed
- Frontend: 133 VM tests pass, including 32 new reconstruction regressions
- Unchanged official Morphz 0.1.3 binary, revision `7e8f7d81f8b00fd45544d94d5b9a321214633df1`, SHA256 `29a5c5cb04cdc407858db04b49c5f52fd18892c831aad395e01cc3e4f172b8d3`

## Fresh actual Runtime evidence

`OPENDOTS_RUNTIME_BINARY=/path/to/morphz node scripts/runtime-authored-recovery-smoke.mjs` passed with 11 deterministic loopback provider calls and zero paid calls:

- A native background Objective authored two genuinely new immutable Markdown versions
- Exact native Job, Call, Activation, Thread and Objective provenance; owner-authenticated downloads match bytes and SHA256
- Same native Call replays its original receipt; changed arguments are rejected
- Two exact current-wait responses carry request, execution generation and Session; replay of an older accepted input does not resolve a newer wait
- Two BFF restarts and one graceful matching Runtime-process restart
- Local document bytes remain downloadable offline, cached task detail is marked stale
- Original durable offline chat command identity is reused, committed reply observed, callback recovery succeeds automatically

`node scripts/runtime-stream-smoke.mjs` also passed: one scripted call, zero paid calls, BFF restart preserves identity, no input replay, honest draft discard, one committed output.

## Boundaries

No real provider/account, paid model, graphical browser/device, deployment, arbitrary binary import, cross-session lineage, crash exactly-once or pending-approval-over-Runtime-restart acceptance is claimed. The historical protected-path approval experiment was not repeated. Experimental backup remains fail-closed for the new schema; its legacy-schema tests are explicitly isolated and do not claim current product backup support.

Earlier surviving validation is preserved in VALIDATION_20260930_SURVIVING.md as historical evidence only. More focused provenance review and bounded-storage regressions are still in progress and will be reported separately.
