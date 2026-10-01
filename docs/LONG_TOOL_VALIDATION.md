# Product long-running shell concurrency validation

## Passed: exact Objective supplemental input

Date: 2026-09-30, 12:43 UTC. An additional run used the same explicitly authorized disposable full-access setup and **unchanged fixed shell command** to validate opendots' new Objective-specific supplemental-input flow against the real Runtime. The earlier 12:25 concurrency measurements below remain a separate passing run.

```sh
OPENDOTS_RUNTIME_BINARY=/tmp/opendots-runtime-bin/morphz node scripts/runtime-long-tool-smoke.mjs --non-sandbox-fixture --directed-input-fixture
```

Observed measurements:

- Actual shell duration: **8,008 ms**
- Foreground chat committed through the real BFF **257 ms** after observed shell start
- Supplemental input admitted **654 ms** after observed shell start, while the original physical exec Job was still `running`
- The exact supplemental text was present in a subsequent Objective model request observed **8,185 ms** after shell start
- **4** immediate deterministic loopback-provider calls, **0 paid calls**, unmodified official Runtime with the same binary hash

Verified through the real product routes and native observations:

1. `GET /api/jobs/:id/input-target` returned the exact active Objective ID and a valid positive execution generation
2. A request with another valid positive generation was rejected with HTTP 409 before any additional native IO POST. The initial generation was 1, so the fixture used `generation + 1` to exercise the exact-match fence rather than invalid generation 0; it does not claim a pause/resume stale-generation scenario was performed
3. `POST /api/jobs/:id/input` sent one real Session IO envelope with `mode: evaluate`, `dispatch_mode: parallel`, and `input_destination: {kind: objective, objective_id, generation}`
4. An immediate same-key retry returned the exact original receipt and produced no second native directed IO POST
5. The already-running exec Job remained `running` after admission; the product still contained exactly one Objective
6. A later actual Objective model request contained the literal supplemental text. The fixture then checked real shell output/exit success before requesting Objective completion
7. Once the Objective was terminal, its input target became unavailable with `objective_terminal`. Replaying the original accepted key still returned the same original receipt without another native POST
8. Typed IO history contained exactly one supplemental `input.accepted` event, with the same Thread ID as the physical exec Job. There was one Objective creation and no `interrupt` dispatch, cancel, pause, resume, or substitute task

The test observes BFF HTTP mutations through a forwarding fetch wrapper; it does not replace native responses or mock the Runtime transport. No Runtime database is edited. The fixture matches literal text and prescribes deterministic actions: this verifies routing, admission, safe continuation, and retry identity, **not natural-language understanding or whether a real model would reason correctly about a correction**. No pending-question/reply-ID scenario, lifecycle generation advance, or crash/restart of this supplemental-input flow is claimed.

The instance/provider/BFF were terminated and the disposable workspace/configuration removed. This remains a **NON-SANDBOX product fixture** with the supported full-access semantics documented below, not a sandbox test or a host security change.

## Passed: explicitly authorized non-sandbox fixture

Date: 2026-09-30, 12:25 UTC. After the user explicitly authorized Morphz's supported application `full_access` mode for the bounded test, the **real BFF and unmodified official Runtime passed the product concurrency scenario**. This is a **NON-SANDBOX product fixture**, not sandbox assurance.

Command:

```sh
OPENDOTS_RUNTIME_BINARY=/tmp/opendots-runtime-bin/morphz node scripts/runtime-long-tool-smoke.mjs --non-sandbox-fixture
```

Observed result:

- Actual fixed shell command duration: **8,004 ms**
- Foreground synthetic model request observed **145 ms** after the tool start marker
- Foreground committed reply visible through the real BFF **238 ms** after the tool start marker
- Actual Runtime exec Job was `running` before the foreground request and still `running` after its committed response; no finish marker existed at that point
- Shell then produced the expected file bytes and stdout, and its Runtime Job became `succeeded` with exit code **0**
- Native Objective became `completed`; typed IO history contained exactly one foreground committed reply and exactly one final Objective report
- **4** immediate deterministic loopback-provider calls; **0 paid calls**; no provider response was held to create the concurrency interval
- Binary hash unchanged: `29a5c5cb04cdc407858db04b49c5f52fd18892c831aad395e01cc3e4f172b8d3`

The actual exec receipt verified this execution boundary:

```json
{
  "network_enabled": true,
  "permission_request_available": false,
  "sandbox_backend": "linux-native",
  "sandbox_status": "disabled",
  "secret_env": []
}
```

### Limited, explicit full-access scope

The opt-in flag changes only `[permissions] mode="full_access"` in the freshly generated disposable Runtime configuration. With no flag the default remains `request_approval`. Pinned source `morphz/src/permission.rs` defines the `FullAccess` preset as `DangerFullAccess`, and its effective network boundary becomes enabled even when `network=false` is present. The result is disclosed above rather than described as network-isolated.

The only shell command is fixed in the test source: a bounded `timeout`, `sleep 8`, and fixed marker/stdout writes in the test's temporary working directory. It makes no network requests, takes no user-supplied command, loads no user profile or credentials, and requests no persistent service. The model endpoint is an immediate loopback-only deterministic fixture using `auth_adapter=none`. Full access is confined by the test's fixed behavior, **not** by a claimed Morphz filesystem/network sandbox.

No host/cloud security setting changed, no tool escalation was used, and no Runtime source/binary was edited. The test instance, BFF and provider were stopped and their disposable configuration/workspace removed afterward; no full-access configuration was installed in the product or another Runtime profile. The historical native-sandbox failure below remains unchanged and is not a product delivery blocker.

## Scope update: excluded from product delivery gates

At 2026-09-30 12:22 UTC, the user explicitly said additional Morphz sandbox testing is unnecessary. At 12:23–12:24 UTC they authorized the separate full-access product test reported above. No further native-sandbox retest or environment request is planned. The result below is retained as a historical failed attempt, not a current opendots delivery blocker and not a sandbox pass. Product UI/API state handling, task responsiveness and visible desktop control remain separate concerns.

## Historical result: command never started

Date: 2026-09-30, 12:19 UTC. The real integration run reached Morphz's actual `exec` tool, but this execution environment refused the Linux sandbox's loopback setup before the controlled command started:

```text
bwrap: loopback: Failed to create NETLINK_ROUTE socket: Operation not permitted
```

The actual tool result reported:

```json
{
  "kind": "exec_result",
  "execution": "completed",
  "process_status": "failed",
  "exit_code": 1,
  "effective_boundary": {
    "network_enabled": false,
    "permission_request_available": true,
    "sandbox_backend": "linux-native",
    "sandbox_status": "enforced",
    "secret_env": []
  }
}
```

`execution: completed` describes return of the tool invocation. It is **not** success: the process failed with exit code 1. The outer tool-observation envelope also said `status: success`; the test must inspect the nested process result rather than treating that envelope as successful shell execution.

Neither start nor finish marker was created. Foreground chat was never submitted because the start condition was not met. Consequently this historical run provides **no evidence that chat remains responsive during a long-running shell tool**. There were two synthetic loopback-provider requests and zero paid calls. The initial test surfaced a missing-finish-marker assertion; its diagnostics contained the exact failed exec receipt above. The script was then improved to parse that receipt first and report the exit code and stderr directly. The improved failure parser passed isolated fixture checks; this native-sandbox mode was not retried after the environment failure.

No sandbox or network restriction was relaxed, no escalation or alternate execution route was attempted, and Morphz was not modified. The isolated Runtime/BFF/provider were stopped; the temporary workspace was removed; a process check found no remaining process from this run.

## Historical reproduction command (not required for delivery)

```sh
OPENDOTS_RUNTIME_BINARY=/path/to/verified/morphz node scripts/runtime-long-tool-smoke.mjs
```

The supplied binary must report:

```text
morphz 0.1.3 (git 7e8f7d81f8b00fd45544d94d5b9a321214633df1)
```

The binary used here was the unmodified official release at `/tmp/opendots-runtime-bin/morphz`, SHA-256 `29a5c5cb04cdc407858db04b49c5f52fd18892c831aad395e01cc3e4f172b8d3`. This is the executable hash, not the archive hash recorded in `RUNTIME_VALIDATION.md`. The test records the binary hash and, on success, verifies it has not changed.

The default native-sandbox variant requires a Linux host supporting that sandbox and having `timeout`, `/bin/sh`, and `sleep` available. No such retest is required for delivery. The separately authorized `--non-sandbox-fixture` variant tests product responsiveness without asserting that the sandbox works.

## Assertions in the passing product run

1. Launch the actual pinned Runtime with a fresh isolated profile and the real opendots BFF; bind the controlled provider through the BFF API
2. Create a native Objective through `POST /api/jobs`
3. The deterministic provider immediately requests the actual `exec` tool, with `cwd` set to the temporary workspace, `wait_ms: 10000`, `background: false`, and `keep_running: false`
4. The shell creates a start marker, sleeps for eight seconds, creates a finish marker, and writes a distinct stdout token. An outer twelve-second `timeout` with a one-second kill grace independently bounds the command
5. Before submitting foreground chat, require the real start marker and a Runtime Execution Job whose tool is `exec` and status is `running`
6. Submit foreground chat through the BFF. Require its committed assistant response in the BFF's durable projection before the finish marker exists; then reread the Runtime Job and require that it is still `running`
7. Require actual finish-marker bytes, actual shell stdout, approximately eight seconds between marker modification times, and the authoritative Job's `succeeded` state with exit code zero
8. Only after that evidence may the fixture request `objective_update(completed)`. Require the BFF's actual terminal Objective projection and exactly one committed foreground reply and one committed Objective final report from typed IO history

The model fixture never holds a provider response to manufacture the concurrency interval. The wait being tested is the real shell process. This differs from `runtime-smoke.mjs`, which holds an Objective's synthetic model response and proves a narrower concurrency condition.

## Source contracts checked

All references are to the pinned Morphz revision above:

- `morphz/src/tool.rs`: `ExecuteCommandArgs` and the `exec` tool definition around lines 8525–8640 specify `command`, `cwd`, `wait_ms`, `background`, and `keep_running`
- `morphz/src/tool.rs` around lines 9367–9369: the completed exec receipt uses `process_status: succeeded|failed` and `exit_code`
- `morphz/src/memory/mod.rs` around line 2974: Execution Job states include `running`, `succeeded`, and `failed`; successful Jobs are not named `completed`
- `morphz/src/web.rs` around lines 605 and 5446: `GET /api/execution-jobs` accepts a Session filter and `include_terminal`
- `morphz/src/permission.rs` around lines 127–143 and 320–354: supported `full_access` preset, disabled Runtime sandbox, and its effective network semantics

## Verification performed

```sh
node --check scripts/runtime-long-tool-smoke.mjs
node scripts/runtime-long-tool-smoke.mjs --fixture-self-test
```

Both passed. The fixture self-test verifies nested exec-receipt parsing, the successful process-state contract, missing-receipt rejection, and preservation of the exact exit-1 sandbox error. It starts no Runtime, makes no model calls, and does not validate concurrency.

The explicitly authorized non-sandbox product integration run passed as documented at the top. The historical native-sandbox attempt did not pass and is excluded from required delivery gates. This test does not establish sandbox isolation, real-model quality (L3), graphical computer interaction (L4), multi-user isolation, or production readiness. It changes no product code, public assets, package scripts, or Runtime source, and performs no direct database writes.
