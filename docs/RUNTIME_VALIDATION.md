# Actual Runtime validation

Date: 2026-09-30. Binary: official Morphz v0.1.3 Linux x86_64, reports git `7e8f7d81f8b00fd45544d94d5b9a321214633df1`.
Archive SHA-256: `db8f0f2ccf73f9ef13a522b67c090f67559cf75c2f6f72dd34501ef1781b3367`.

Latest rerun after removal of the Runtime memory experiment: 2026-09-30 12:13 UTC, unmodified official binary, all product-smoke assertions passed. Ten local synthetic provider calls; zero paid calls.

## Passed L2 product test

Command: `OPENDOTS_RUNTIME_BINARY=/path/to/morphz node scripts/runtime-smoke.mjs --product`

The test launches a real isolated Runtime and the real opendots BFF. A separate local Node HTTP server implements the OpenAI Chat Completions wire protocol with scripted responses/tool calls. Runtime configuration uses `protocol=openai-chat`, loopback `/v1`, and `auth_adapter=none`; the account is explicitly bound to the new Agent. No existing user profile or model credential is read. No external paid inference is called.

Verified sequence:
1. Real BFF persists identity and creates the real Agent/Context/Session
2. Account selection/binding uses actual Morphz endpoints
3. Typed input retry returns the same admission receipt
4. Real Morphz `write` tool creates a file; test reads its actual bytes
5. Native Objective starts; its first synthetic provider response is held
6. A second chat gets a committed response while that Objective model request remains waiting
7. Releasing the fixture lets the Objective write another actual file, call `objective_update(completed)`, and atomically finish with its final report
8. Native reminder is created once, paused and cancelled with Runtime revisions
9. A real out-of-workspace write triggers actual pending permission; the BFF submits deny, and the forbidden file does not exist
10. Agent-created Frame recall is read through official APIs; the UI offers no manual memory mutation
11. An actual terminal Objective produces an in-app notice; acknowledgement survives restart
12. Both processes restart; stable IDs, original event contents and same-ID receipt survive; no extra user input admission appears

The concurrency wait is in the synthetic MODEL response, not a long-running shell tool. This validates real admission/orchestration behavior under that condition, not every tool/backend or real-model judgement. The fixture decides actions and returns fixed text; it does not understand natural language.

## Integration defect caught and fixed

Context overview returns active Objectives, excluding terminal ones. Caching it alone left the product showing active after real completion. The implementation now reads the bounded scheduler with include_terminal=true, preserves revision monotonicity, surfaces truncation, and does not recreate an uncertain Objective when the inventory is incomplete.

## Other evidence

- Upstream packaged-runtime IO smoke passed: authenticated capabilities, no implicit storage fence
- TypeScript strict noEmit check added and passed
- Direct production npm dependency advisory check reported zero known findings at check time; this is not a security audit
- Computer gateway has real local WebSocket-to-TCP fixture tests; actual VNC/Chromium display not yet run

## Not yet proved

Real-model understanding/quality/cost (L3), long shell-tool concurrency, external connector effects, actual graphical desktop/noVNC interaction and takeover (L4), public multi-user isolation, semantic memory correction/forgetting, voice, and production soak remain unverified or not implemented. Streaming-specific evidence now has a separate passing actual-Runtime test: `scripts/runtime-stream-smoke.mjs` observes an intermediate public-text prefix, restarts the BFF during a gated inference, confirms no input replay, honestly discards unfinished drafts, and receives one exact committed reply. It uses the application WebSocket compatibility observer because the pinned typed-IO draft path has a source-verified field mismatch; see RUNTIME_COMPATIBILITY.md. It does not claim recovery of a missing draft prefix.

## Current product verification snapshot

At 2026-09-30 12:16 UTC, `npm test` passed 113 tests with zero failures/skips, and strict `npm run typecheck` passed. This includes synthetic speech adapter/capture tests, not a real microphone/provider validation. The real Runtime streaming and resource scripts also passed again on the unmodified official binary (1 and 2 local fixture calls respectively). A transient stream teardown failure while the shutdown method was being integrated was fixed and the complete script rerun successfully. Final UI modal-race regression and HTTP speech additions are reviewed separately before committing the voice feature.

Final voice integration check at 12:17 UTC: `npm test` 116/116 passed, zero skipped; strict TypeScript and syntax/diff checks passed. Independent static review cleared the modal hidden-microphone race after generation-fencing regressions. This does not validate real microphone permissions, provider billing/recognition quality, or visible browser pixels.

Scope update 12:22 UTC: further upstream sandbox validation is excluded at the user’s request. The optional long-shell attempt is historical, not a delivery blocker or a successful result. Focus remains on opendots UI/API/state behavior and actual visible desktop integration; no sandbox restriction was relaxed.

After explicit user authorization, an isolated supported `full_access` fixture passed actual long-running exec + foreground chat: 8,004ms shell, foreground committed response238ms after start while native Job remained running, exit0 and authoritative Objective completion. Four immediate local fixture calls, zero paid calls. This is product concurrency evidence with sandbox disabled, never sandbox assurance or a product-default configuration. Full details and cleanup in LONG_TOOL_VALIDATION.md.

At 12:32 UTC the resource L2 script now exercises the actual PRODUCT upload API rather than staging directly: same declaration retry, partial byte upload, BFF restart, native offset reconciliation, remaining bytes/hash, atomic attachment-bearing message, same-command retry, changed text/new command/cancel rejection after seal, immutable output copy/download, and consumed-stage retry after a second restart all passed. Two scripted provider calls, zero paid calls. Module cancellation race/uncertain-intent tests and independent review are additional L1 evidence.

Exact-task supplement L2 at12:43 UTC: on the same authorized NON-SANDBOX fixed8s fixture, ordinary foreground chat committed at257ms; the task-specific supplement was admitted at654ms while the original exec remained running, and appeared in the following Objective model input at8185ms. One exact native objective/generation/thread admission, mismatched generation rejected before admission, same-key receipt during execution/after completion, no global interrupt/new Objective. Four local scripted provider calls, zero paid calls. Service regression separately verifies lost response + restart + generation advance returns the original receipt while new stale keys reject. See LONG_TOOL_VALIDATION.md and OBJECTIVE_INPUT.md.

At12:47 UTC the aggregate reached151/151 tests with zero failures/skips; strict typechecking, syntax checks and diff checks passed. Generation-bound supplement UI was subsequently reviewed and committed as ce52888, including local-only attempt recovery on paused/completed tasks. These are behavioral fixtures, not browser pixel/live-device verification.
