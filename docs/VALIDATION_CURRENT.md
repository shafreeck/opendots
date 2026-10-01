# Reconstructed-tree validation

2026-10-01 03:58 UTC. Exact code checkpoint: `9601a544a43a7eb7050b26009256883a19c9824f`. This is fresh reconstruction evidence, not certification of the inaccessible historical `683ccdd` tree. Original history was not recovered. See [recovery ledger](../RECOVERY.md).

## Current checks

- Aggregate: 700 tests, 695 passed, 5 intentionally skipped, 0 failed
- Strict TypeScript, Node syntax checks and whitespace checks passed
- Frontend: 153 VM tests pass, including 52 new reconstruction regressions
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

A dedicated dot-cloud browser initially navigated to `http://127.0.0.1:42919` and returned `net::ERR_BLOCKED_BY_CLIENT`. A later attempt to select failed tab 14 returned `The requested URL protocol is not allowed. Allowed protocols: http:, https:`. The failed tab’s actual URL was not returned. These are distinct observations and do not establish an explicit prohibition on loopback HTTP or a confirmed cause for the initial navigation failure. The browser never reached login. Six-view navigation, task/document controls, downloads, screenshots and graphical rendering remain untested. No forwarding workaround or policy bypass was attempted; the fixture was stopped. This does not establish Mac/mobile acceptance.

## Final recorded-milestone parity audit

[RECOVERY_PARITY.md](RECOVERY_PARITY.md) maps each recorded core milestone and endpoint to fresh evidence. Final fixes include accepted-approval acknowledgement after the pending row disappears; ambiguous ordinary chat/task submissions fail closed unless an exact original is explicitly selected; monotonic document-head updates and delayed-page viewport preservation; exact desktop authored-version saves; response-lost turn cancellation; and synchronous native-host policy/owner guards with no automatic retry after authorization denial.

The exact immutable export passed 700 tests (695 passed, 5 skipped) and the 12-call native core journey again. A clean offline, scripts-disabled lockfile install was also verified on the reconstructed source line. The numerical total coincides with a historical report but is not evidence of original test-source recovery or identical coverage; the explicit parity checklist is the evidence.


## Supplemental optional-test verification — 2026-10-01 04:41 UTC

This is a separate addendum, not a replacement aggregate run. Local documentation checkpoint `214f087bb31c614485965c150f139c17cdc768d3` was verified against remote `5db148523658bfec01834b76c64a3bd6229437b7`, with identical tree `54a18cddb0ff349d0b2afccecf8003fd2a4fcc38`. The original aggregate remains **695 passed, 5 skipped, 0 failed**.

- Three formerly skipped optional native tests were explicitly enabled: `calendar-native`, `calendar-proposal-native`, and `connector-native`. Fresh result: **3 passed, 0 failed, 0 skipped**
- The official Runtime binary SHA256 listed above was verified before and after. Four deterministic loopback model calls were made, with zero paid calls
- Calendar evidence covers exact future UTC, persisted schedule identities across BFF restart, and pause/resume/cancel. Proposal evidence covers owner confirmation before native schedule admission and immutable old Call receipt. No due triggers fired
- Connector-native evidence covers a real Runtime host-tool receipt, exact native provenance and replay after completion, using synthetic GitHub transport. It does not certify live GitHub connectivity
- The anonymous public GitHub integration test was explicitly run twice. Both runs **failed**, each with `connector_request_aborted` at the five-second timeout (retry approximately 5004 ms). A DNS lookup for `api.github.com` returned `EAI_AGAIN`. This supports an environment/DNS transport issue as a possibility; neither the root cause nor a product defect is established
- The root-only ownership test remains unrun because the execution user has UID 1000

Local evidence logs: `/tmp/opendots-20261001-optional-runtime.log`, `/tmp/opendots-20261001-optional-github.log`, and `/tmp/opendots-20261001-optional-github-retry.log`. No production code or Runtime changes were made for this addendum. Graphical and real-device acceptance remain open; the browser observations above were corrected without retrying or bypassing the failed flow.
