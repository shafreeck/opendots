# Reconstructed-tree validation

2026-10-01. This is fresh reconstruction evidence, not certification of the inaccessible historical `683ccdd` tree. Original history was not recovered. See [recovery ledger](../RECOVERY.md).

## Current checks

- Aggregate: 660 tests, 655 passed, 5 intentionally skipped, 0 failed
- Strict TypeScript, Node syntax checks and whitespace checks passed
- Frontend: 136 VM tests pass, including 35 new reconstruction regressions
- Unchanged official Morphz 0.1.3 binary, revision `7e8f7d81f8b00fd45544d94d5b9a321214633df1`, SHA256 `29a5c5cb04cdc407858db04b49c5f52fd18892c831aad395e01cc3e4f172b8d3`

## Fresh actual Runtime evidence

`OPENDOTS_RUNTIME_BINARY=/path/to/morphz node scripts/runtime-authored-recovery-smoke.mjs` passed with 12 deterministic loopback provider calls and zero paid calls:

- A native background Objective authored two genuinely new immutable Markdown versions
- Exact native Job, Call, Activation, Thread and Objective provenance; owner-authenticated downloads match bytes and SHA256
- Same native Call replays its original receipt; changed arguments are rejected
- Two exact current-wait responses carry request, execution generation and Session; replay of an older accepted input does not resolve a newer wait
- Two BFF restarts and one graceful matching Runtime-process restart
- Local document bytes remain downloadable offline, cached task detail is marked stale
- Actual native admission with a deliberately lost transport response retains its unknown command; after Runtime restart, replay returns the exact original native receipt and exactly one output
- Separately queued offline chat retains its command identity and produces one output; callback recovery succeeds automatically

`node scripts/runtime-resource-smoke.mjs` passed with two scripted calls: real staged upload, registered input/output resources, exact downloads, native-reference document lineage and BFF restart.

`node scripts/runtime-stream-smoke.mjs` also passed: one scripted call, zero paid calls, BFF restart preserves identity, no input replay, honest draft discard, one committed output.

## Boundaries

No real provider/account, paid model, graphical browser/device, deployment, arbitrary binary import, cross-session lineage, crash exactly-once or pending-approval-over-Runtime-restart acceptance is claimed. The historical protected-path approval experiment was not repeated. Experimental backup remains fail-closed for the new schema; its legacy-schema tests are explicitly isolated and do not claim current product backup support.

Earlier surviving validation is preserved in VALIDATION_20260930_SURVIVING.md as historical evidence only. Focused independent review is complete: 17 adversarial task-detail tests cover route contradictions, generation regression, approval revision conflicts, scoped resources, stale evidence and revoked authority. Receipt count/byte quotas and atomic rollback are tested.

## Graphical smoke attempt

A dedicated dot-cloud browser was pointed at an isolated loopback fixture. Navigation failed with `net::ERR_BLOCKED_BY_CLIENT`, and selecting the tab explicitly reported a browser URL security-policy block. The browser never reached login. Six-view navigation, task/document controls, downloads, screenshots and graphical rendering remain untested. No forwarding workaround or policy bypass was attempted; the fixture was stopped. This does not establish Mac/mobile acceptance.
