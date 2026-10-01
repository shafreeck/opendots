# Recorded core-milestone behavior checklist

This is a behavior-and-evidence audit of the reconstruction, not a claim that the original commits or lost test files were recovered. Historical commit labels below identify recorded milestones only. The final Git history is new.

## Task details, progress and results (recorded 49cd7ad)

- Exact owner/Session/Objective/generation scoping; native supervision, attached-child generation and exact evaluation activation proofs
- Committed text/resources are linked only by matching native Thread/root/Activation evidence; unrelated or contradictory evidence is excluded
- Typed waits never invent unavailable question text; scoped pending approvals are summaries and require fresh full review
- Bounded/missing evidence is explicit; offline cached details cannot authorize fresh control
- Evidence: test/task-detail.test.ts, test/task-detail-review.test.ts, test/recovery-http.test.ts; actual Runtime authored-recovery journey

## Generated documents (recorded fd652d4)

- New literal text, Markdown and CSV; immutable bytes/versions/SHA256, exact native provenance, append parent/revision CAS
- Same Call returns original receipt; changed arguments/provenance and foreign scope fail closed
- Owner-authenticated inert downloads, offline history, rollback, byte/receipt quotas, bounded version pages
- Evidence: test/authored-documents.test.ts, test/authored-host-service.test.ts, test/authored-http.test.ts; actual Runtime creates two Markdown versions and verifies exact downloads, task association and replay across restarts
- Desktop save flow accepts only exact authenticated authored-version download URLs, using the existing explicit native save dialog and exclusive save policy; VM/main-process fixtures do not claim real-device acceptance
- Generated history advances only validated monotonic document heads while retaining older immutable links
- No arbitrary binary import, cross-session lineage or new backup support

## Ordinary submissions and exact waits (recorded 329145d)

- Metadata-only retry identities/fingerprints survive reload; unknown outcomes retain the original command ID and payload
- Exact current wait carries Objective generation, Session and request identity plus explicit acknowledgement that question text is unavailable
- Accepted old input replay cannot resolve a newer wait; stale new request keys are rejected
- Ambiguous same-payload ordinary submissions must fail closed, with an explicit exact-command recovery path rather than first-match guessing
- Evidence: test/frontend.test.ts, test/task-recovery.test.ts, test/recovery-http.test.ts; actual Runtime exercises two waits and separate pending/accepted-but-response-lost chat admissions through restart

## History and command lookup (recorded 0f962b8)

- Polling head returns newest 100 messages and bounded terminal commands, retaining all unresolved commands
- Session-scoped older/gap pages preserve native opaque checkpoints; stuck/cross-session/late pages cannot erase gaps or newer heads
- Exact durable command lookup works independently of bounded head history
- Delayed page responses preserve the viewport reached by the user while the request was in flight
- Evidence: test/task-recovery.test.ts and test/frontend.test.ts, including older omitted command observations and successor outside current history

## Approval/control recovery (recorded 6a25fd7)

- Task cards enter the reviewed detail path; retries preserve original revision/action/key
- Unknown approval decisions remain unknown after stale rejection and restart, blocking replacement or opposite decisions
- Closing/cancelling a modal does not clear an unknown attempt or grant a permission
- An accepted exact approval receipt can be explicitly acknowledged after its pending row disappears; this clears only local retry metadata and does not enable a new decision from missing evidence
- Evidence: test/task-recovery.test.ts and test/frontend.test.ts. Native pending-approval-over-Runtime-restart remains unverified; the historical protected-path branch was not repeated

## Fresh task review (recorded 683ccdd)

- Requires a fresh authoritative native revision advanced beyond the unknown predecessor, explicit separate acknowledgement and a new linked command
- Concurrent reviewers cannot fork a predecessor into multiple successors; backend transaction/unique lineage wins exactly once
- Historical unknowns stay unknown; terminal successor receipts do not retroactively resolve them
- Successor outside head history, rejected successor after reload, multistep chains, corrupt storage, missing/cyclic/conflicting ledger evidence and stale late responses fail safely
- Independent later unknown control can be recovered after an earlier reviewed chain terminates, while older uncertainty stays visible
- Evidence: test/task-recovery.test.ts and test/frontend.test.ts

## Runtime recovery

- Actual unchanged official Runtime: two BFF restarts and one graceful matching Runtime-process restart
- Actual accepted input with synthetic response loss recovers original native receipt/command; separately queued offline input recovers; each produces one committed output
- Offline document bytes remain available, task freshness becomes stale, and callback automatically reconnects
- Evidence: scripts/runtime-authored-recovery-smoke.mjs (12 scripted local calls, zero paid calls). Additional native resource and stream fixtures pass with 2 and 1 local calls respectively
- Native 401/403, changed policy or owner binding are latched fail-closed without automatic retry/listener admission; only bounded transient transport/service failures retry
- A synchronous factory policy/identity guard is rechecked at actual document receipt/transaction admission after asynchronous verification, without disabling independent offline owner history
- No crash exactly-once, real-provider, graphical-host or device acceptance inferred

## Counts and remaining boundary

The surviving source baseline freshly passed 551 tests with 5 skips. Historical records mention 695 passes with 5 skips for the inaccessible later tree. The reconstructed suite was rebuilt from surviving source, patch scripts, recorded contracts and new independent regression tests; original later test files were not recovered. Different counts are neither proof of regression nor proof of parity. The checklist above and fresh exact-commit results are the evidence.

The cloud-browser attempt was denied by URL security policy before login; no page navigation, rendering, downloads or screenshots were tested in a real browser. Real model/BYOK use requires secure configuration and an explicit paid-test scope. Mac/mobile/graphical-host acceptance, deployment, private OAuth, unsupported import contracts and experimental current-schema backup remain separate gates. Voice is deferred.

## Endpoint acceptance ledger

- GET `/api/jobs/:id/detail`: scoped native/cached projection; HTTP routing, owner revocation, stale/offline, contradictory evidence, approval summary and real Runtime task-document association tested
- GET `/api/commands/:key`: exact local durable ledger, fixed owner/Session envelope, out-of-head recovery and changed-key rejection tested
- POST `/api/messages/page`: CSRF, strict fields, 1–100 limits, bounded opaque cursor syntax, Session scope, gap/late-page behavior tested
- GET `/api/jobs/:id/input-target` and POST `/api/jobs/:id/input`: explicit unavailable-question acknowledgement, exact Session/request/generation, stale rejection and same-key native replay tested
- POST `/api/jobs/:id/control`: displayed revision, allowed action, original retry identity, fresh explicit predecessor review and concurrent successor fork prevention tested
- POST `/api/approvals/:id/decision`: fixed decision/revision/key, unknown preservation and opposite/replacement protection tested with controlled native-protocol fixtures; native pending-approval-over-restart is not claimed
- GET `/api/authored-documents`, GET `/api/authored-documents/:id`, and POST collection/version `/page`: owner authentication, strict fields, immutable bounded history and offline reads tested
- GET `/api/authored-documents/:id/versions/:version/content`: owner authentication, exact bytes/hash, inert attachment media, sandbox CSP, nosniff, logout denial and actual native-generated content tested
- POST `/api/host-tools/documents/call`: private separate callback token, exact native proof, receipt replay/change conflict, limits and restart reconnect tested; not a browser mutation endpoint

HTTP/VM coverage is distinct from graphical browser coverage. The policy-blocked cloud browser did not reach any product page.
