# Latest recorded validation checkpoint

Date: 2026-09-30 17:40 UTC. Code checkpoint: `a497382` (CLI help wording added after the aggregate).

- `npm test`: 485 tests, 480 passed, 5 intentionally skipped,
  zero failed. The skips are live public GitHub, native connector/calendar/proposal L2,
  and one UID-specific configuration fixture. All three native L2 checks were run separately.
- `npm run typecheck`: passed on the merged HTTPS transport working tree.
  The lead reran 35 focused remote-transport/desktop checks; the independent
  reviewer ran 54 backend checks and 25 desktop checks. Node syntax and `git diff --check` also passed.
- Independent read-only reviews cleared owner-auth backend/UI and concrete
  connector configuration/listener/BFF integration. Reviewers reproduced the
  reported revocation races before and after their fixes.
- Explicit canonical HTTPS origin integration and desktop transport were
  independently reviewed, including normalized Chromium TLS-bypass switches.
  Fixtures simulate the trusted proxy hop; no real TLS proxy or phone was exercised.
- Official pinned Morphz checkout remains clean; no Runtime patches or manual
  Frame editing are in this product.

## Recent actual Runtime reruns

Each run used the unchanged official v0.1.3 binary, disposable local data and a
scripted loopback model provider. No paid inference or personal credentials.

| Command | Outcome | Local provider calls |
| --- | --- | --- |
| `node scripts/runtime-smoke.mjs --product` | Core file tool, conversation/task state, receipts/restart, native schedule lifecycle, denial, recall and inbox durability passed | 10 |
| `node scripts/runtime-stream-smoke.mjs` | Public stream/restart/no input replay/final deduplication passed | 1 |
| `node scripts/runtime-resource-smoke.mjs` | Native upload offsets/restart/hash, exact attachment command and registered resource downloads passed | 2 |
| `node --test test/connector-native.test.ts` | Native host callback and exact Job scope, committed result and replay passed; public GitHub transport was synthetic | 2 |
| `node --test test/calendar-native.test.ts` | Daily/weekly future native UTC, restart stable IDs and pause/resume/cancel passed; no due trigger in this fixture | 0 |
| `node --test test/calendar-proposal-native.test.ts` | Actual host proposal, zero schedule POSTs before owner, one after confirmation, exact UTC and restart/replay identity | 2 |
| `npm run test:runtime-calendar-delivery` | One actual UTC due reply while BFF offline, recovered exactly once across two BFF restarts | 1 |

Set `OPENDOTS_RUNTIME_BINARY` to the verified runtime executable for these runs.
These are L2 scheduling/protocol/application evidence, not real model quality,
actual microphone/audio-provider performance, live desktop input fidelity or
successful Internet service connectivity. The historical real GitHub GET timed
out; that live boundary remains unverified. See `ACCEPTANCE.md`, `STATUS.md` and
`COMPLETION_GAPS.md` for the wider scope and later updates.

The Electron client now has explicit native microphone consent and bounded,
exclusive artifact saves, with policy/controller fixtures and a dependency lock;
it has not been installed/launched here. The approved visual refinement is implemented; generated
concept previews do not substitute for real browser pixel QA. No deployment or
GitHub publication has occurred.

Calendar integration was independently reviewed with 107 passing combined
module/HTTP/frontend/audio checks and additional admission/shutdown/lifecycle probes.
The lead separately reran its native L2 test. The calendar feature includes explicit UI/API and an opt-in model-callable
proposal-only host; it cannot self-confirm. The existing native schedule_tx tool
is unchanged. See CALENDAR_PROPOSALS.md and CALENDAR_DELIVERY_VALIDATION.md for
the exact evidence and the failed/interrupted fixture setup attempts that were
not counted as passes.

## Native mobile checkpoint

The separate apps/mobile lockfile passed a clean offline scripts-disabled install.
All17 mobile policy/state/script tests and strict TypeScript passed, independently
rerun by the reviewer and lead. A transpiled App callback fixture additionally
checked background/reconnect and stale native callbacks. The final one-worker
offline Metro export produced both Android and iOS Hermes bytecode bundles; the
initial default-worker export failed with exit137 and is not counted as a pass.
These checks do not compile an APK/IPA or verify native permissions, storage, TLS
or a real device. The bounded trusted-BFF wrapper was independently reviewed;
platform navigation/download/cookie caveats remain in apps/mobile/README.md.
The root aggregate above is separate from these17 mobile tests.


## Artifact lineage and recovery checkpoint

Artifact module, BFF/desktop download and Files UI reviews cleared their bounded
ordinary correctness scope.47 focused backend/auth/desktop tests passed, and
95 frontend/audio tests passed. The actual unchanged-Runtime resource script
was extended and rerun successfully: native input/output provenance, two linked
versions, exact downloaded bytes, original receipt and history across restart;
two scripted local provider calls, zero paid calls.

Product-only backup/restore has11 passing synthetic tests, including committed
WAL data, new-path/no-overwrite behavior, restored-session invalidation and exact
artifact/calendar/effect receipts. Final independent security review was stopped
and remains incomplete after correction of the reported destination-path issue.
The CLI is explicitly experimental and is not application-enabled. No real
private-data recovery or whole-system consistency drill has been performed.
See ARTIFACT_VERSIONS.md and BACKUP_RECOVERY.md for exact limits.
