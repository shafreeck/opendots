# Product-owned computer Edge bridge

## Status and boundaries

The TypeScript protocol client and durable executor are implemented against the existing Morphz Edge v1 contract. Unit tests use an injected HTTP transport, in-memory/isolated SQLite and synthetic image/action drivers. The separate L2 script also passed against the unchanged official Runtime, proving native Runtime-to-model screenshot delivery with a synthetic 1px image. These checks do **not** establish a live desktop, deployed isolation boundary, or verified x11vnc input fence.

No Runtime code is modified. No module import or constructor pairs a device, generates credentials, connects to a service, installs a host manifest, starts a desktop, or grants computer control. A host must explicitly supply the existing provisioned device signer, fixed bindings, trusted driver, arbiter and authorizer before calling `runOnce()`.

Native generic remote-target approval is separate from approval of a particular web action. Neither possession of an Edge claim nor acknowledgment of `side_effect_started` means a user approved a purchase, upload, send, credential entry or other consequential effect. Production integration must not supply an unconditional authorizer.

## Existing source contract

References are pinned to Morphz `7e8f7d81f8b00fd45544d94d5b9a321214633df1`, read-only during implementation:

- `morphz/src/host_tools.rs`: `MORPHZ_HOST_TOOLS_FILE` manifest, private transport, `host_*` names, context restrictions and the Runtime-authored invocation identity
- `morphz/src/tool.rs`: physical/thread-target defaults; target property injection; `ToolExecutionResult` transport version 1
- `morphz/src/execution_target.rs`: target selection/capabilities, `EdgeNodeBackend`, frozen route and `execution_scope`, generic remote-target approval
- `morphz/src/sdk.rs`: Ed25519 connection proof, node heartbeat, claim/heartbeat/finish DTOs
- `morphz/src/web.rs`: existing `/api/edge/...` routes and bearer-header authentication
- `morphz/src/orchestrator/orchestrator.rs`: immutable Thread target affinity and import of real model attachments
- `application/packages/application/src/host-tools-ipc.ts`, `agent-tools.ts`, `browser.ts`: private host transport, Runtime-authored scope, durable at-most-once browser receipts and human effect approval patterns

The product consumes these wire contracts; it does not copy or patch the Runtime implementation.

### Important differences between host and Edge execution

A local `HostTool` implements text `execute()` only. Returning JSON named `_morphz_tool_result` through that callback does not turn it into an image. `EdgeNodeBackend` explicitly decodes that envelope, which is the image-capable path used here.

`computerHostManifest()` produces an operator-only template for `host_opendots_computer`. Its local callback endpoint **must fail closed** (503, no input). Installation is external to this module. The desktop is an `edge_node` target whose only capability is `host_opendots_computer`; it must never advertise `exec`, `read`, `write`, `eval`, `transfer`, generic CDP or arbitrary shell execution. The standard broad-capability `morphz-edge` executable is not the desktop worker implemented here.

The manifest's `context_ids` check runs inside local `HostTool.execute()`, not inside the Edge backend. Consequently, this worker independently validates Principal, Agent, Context, Session, node, target, policy digest and frozen route. Model arguments cannot choose any of those identities.

A Thread's first physical action binds its target. A Thread already bound to `target-default` cannot be redirected to the desktop. Select the desktop on a fresh execution Thread, or use the Runtime's supported `schedule_tx.spawn` flow, retaining the same Agent/Context/Session and Objective lineage. Do not recreate the user's Session or silently change task generation.

## Modules and integration

- `src/computer-edge-types.ts`: strict wire identity checks and narrow action/driver types
- `src/computer-edge-client.ts`: fixed-endpoint Edge protocol client and pure provisioning templates
- `src/computer-edge-executor.ts`: durable dispatch journal, observations, effect-permit checks and terminal delivery retries

The client takes a fixed endpoint, `workerId`, `ComputerEdgeBinding`, and an injected `signConnectionProof(bytes)` returning a hex Ed25519 signature. It never loads or creates a private key and never writes connection tokens to the journal. HTTP is limited to loopback unless an explicit operator-only `allowPrivateHttp` assertion names the fixed private service endpoint. Redirects are forbidden. This option does not relax `LocalOperatorAdapter` or introduce a browser-configurable endpoint.

The existing protocol uses:

1. `POST /api/edge/nodes/:nodeId/challenge`
2. Sign exact UTF-8 bytes `morphz-edge-connect-v1\0nodeId\0challengeId\0nonce`
3. `POST /api/edge/nodes/:nodeId/connect` with `challenge_id`, `nonce`, `signature`
4. Subsequent calls use `Authorization: Bearer <short-lived connection token>`; never a query token
5. `POST .../heartbeat` publishes only the fixed desktop capability/target
6. `POST .../jobs/claim?wait_seconds=20` with `worker_id`, `lease_seconds:30`
7. `POST .../jobs/:jobId/heartbeat` with `expected_revision`, `claim_token`, `lease_seconds`, `side_effect_started`, `progress`
8. `POST .../jobs/:jobId/finish` with `expected_revision`, `claim_token`, `status`, `output`, `error`

`computerPairingRequest()` only builds the native request shape from an explicitly supplied pairing code and public key. It does not generate either value or send it. Real pairing/provisioning must use the user's approved setup flow.

`ComputerEdgeExecutor` takes an existing SQLite handle or product DB path, the same fixed binding/worker ID, transport, trusted driver, arbiter and required authorizer. Public lifecycle methods are `runOnce()`, `retryFinish(jobId)`, `maintainLease(epoch)`, `expireRetained()` and `close()`.

Arbiter callbacks map to the existing internal gateway: `performAi`, `renewAi` and `pauseTrusted(uncertainty,expectedEpoch)`. A stale failure may record uncertainty but must not revoke a newer human epoch. Startup recovery passes no epoch and pauses conservatively. There is no browser endpoint accepting arbitrary AI input or renew commands.

### Model-visible operations

- `status`: current owner, epoch and fixed display identity/dimensions
- `observe(epoch)`: bounded fresh PNG, native model attachment and a single-use observation ID
- `act(epoch,observationId,operation)`: move, click, scroll, approved key or bounded plain text
- `receipt(jobId)`: saved receipt only for that same fixed execution Thread

No arbitrary scripts, selectors, shell commands, executable paths, clipboard or file uploads are accepted. The only modifier chords are the explicit `Ctrl+L` and `Ctrl+A` key values. Text excludes control characters so an Enter gesture is separately visible and approved. Coordinates are checked against the actual observed display.

The driver must check `assertCurrent()` immediately before each **new bounded gesture**: one typed character, click press/release pair, scroll detent or key press/release pair. It may finish only its own admitted release/restoration after revocation, then reject the next gesture. Do not buffer a whole string under one permit. It must never release preexisting human-held input. Abort/deadline behavior must settle in bounded time; the arbiter waits for the actual driver promise before releasing in-flight ownership.

### Exact effect authorizer

The callback receives:

```
authorize(scope, request, {
  jobId,
  actionDigest?,
  signal,
  expiresAt
}) -> Promise<void | ComputerActionPermit>
```

Read operations still require current fixed-principal/session authorization. An `act` must return a trusted receipt containing `approved:true`, `receiptId`, `jobId`, `threadId`, `epoch`, `observationId`, `actionDigest`, `expiresAt`. Every field must match the exact pending action. `computerActionDigest(operation)` computes the expected hash. Browser/model-supplied “approved” fields are never accepted.

The initial product policy requires exact local user approval for each act. Identity and ownership alone are insufficient. The UI should show the immutable observed image and exact proposed action, including transient text when relevant. `approvalObservation(observationId,threadId,epoch)` returns that bounded image and metadata to an internal, separately authorized UI adapter. It must not substitute a newer live preview or accept arbitrary screenshot IDs from another scope.

Authorization has a maximum 45-second deadline and receives an abort signal. A native heartbeat every five seconds keeps the 30-second Edge job lease alive and renews only an already-valid AI lease at the same epoch. Denial, expiration, takeover, cancellation or connectivity failure prevents dispatch. Production authorizers must remove/disable pending approval controls on abort. Restart invalidates all observations, so a stale persisted approval is never actionable.

## At-most-once dispatch and recovery

1. Validate native job/frozen identity and reject unsupported tool/action fields
2. Persist native job ID, exact content fingerprint and sanitized claim; raw arguments are not stored in the product journal
3. Validate observation, obtain the exact effect permit, then atomically consume that observation
4. Persist/receive native `side_effect_started:true` acknowledgment
5. Recheck current epoch, display and permit inside the physical arbiter immediately before input
6. Save the terminal result before attempting native `finish`

A lost finish response retries only the saved completion envelope. It never re-enters the driver. Native `finish` is revision/claim-fenced and may return 409 after a lost acknowledgment of an already-committed result. Such a conflict remains unconfirmed; the worker does not manufacture confirmation or repeat input. A future host reconciliation view may inspect the existing native job through the authorized SDK.

An interrupted running journal entry becomes `unknown` on restart and causes a trusted uncertainty pause. Unknown effects require user reconciliation; no automatic replay, auto-return to AI, new command identity or fresh screenshot is substituted for the old job. A changed argument/frozen-route fingerprint under the same native job ID is a conflict.

## Bounds and retention

- Screenshot: PNG, at most 1 MiB, validated dimensions and fresh display identity/time
- Observation validity: 60 seconds; one use, exact Thread/display/epoch; restart invalidates it
- Authorization wait: at most 45 seconds
- Driver operation deadline: 10 seconds; driver must honor abort and finish only its bounded owned gesture
- Cached native result: 10-minute retry eligibility, at most 32 retained screenshots; admission also stops at 32 pending native-result deliveries; consumed acknowledged screenshots are discarded during housekeeping
- HTTP responses: 2 MiB; completion requests: 1.6 MB; bounded connect/sign/HTTP deadlines

The product journal stores hashes rather than raw typing/key arguments. Safe own error codes replace driver/proxy error messages, stdout, stderr and argument dumps. The module does not log image bytes, text, credentials or endpoint bodies.

Screenshot completion payloads and short-lived native claim tokens are sensitive local journal data. Use the existing private product DB and private directory; do not expose it to an unrestricted executor. Expired payloads are logically inaccessible and removed by `expireRetained()`, the next work cycle or startup. This is not a promise of physical erasure from SQLite pages/WAL, backups, native Edge command storage, model-input resources, or provider storage. The native Runtime remains authoritative for its own retention.

## Deployment and return-to-AI requirements

Runtime and desktop must have separate filesystem and network namespaces. No shared X socket, Xauthority, browser profile, VNC/CDP socket, host Docker socket or unrestricted execution target may bypass the arbiter. Desktop-to-Runtime traffic uses an explicit fixed trusted connector and outbound Edge protocol. Preserve the product operator adapter's loopback boundary.

The human-control x11vnc process is separately owned from the persistent read-only preview, Xvfb and browser. Return must revoke/close human connections, gracefully stop that exact owned input-server instance, require a verified clean exit, perform an X roundtrip, verify no held input and capture the unchanged display before granting AI. Held keys/buttons, timeout, force-kill or capture failure leave control paused. Do not synthesize mouse-up to “repair” a preexisting drag/click.

A clean input-server drain is not proof that a website/network operation completed or was undone. Preserve uncertainty and any required explicit user acknowledgment. The Return button also does not prove that the Runtime task resumed: use the exact saved active Objective generation for continuation and require a new observe before the next action.

Official x11vnc 0.9.16 source distinguishes SIGINT's graceful shutdown flag from other signal exit paths; normal cleanup calls `XTestDiscard` and `XCloseDisplay`. Deployment must pin/verify the actual binary and test that lifecycle rather than assume an arbitrary exit settles input: [official cleanup.c](https://raw.githubusercontent.com/LibVNC/x11vnc/0.9.16/src/cleanup.c).

## Required next acceptance

Before enabling production control: actual headed-display observation and input; clean held-input-free human return; repeated takeover during gestures; connectivity loss and process restart; stale approvals and route mismatch; no direct input endpoint reachable from native exec; exact-action approval UI; bounded shutdown and sensitive-data retention checks. Synthetic tests alone do not satisfy these deployment checks.


## Executed L2 evidence

On 2026-09-30, `scripts/runtime-computer-edge-smoke.mjs` passed against the verified, unchanged Morphz 0.1.3 binary at the pinned commit. Run explicitly with:

```sh
OPENDOTS_RUNTIME_BINARY=/path/to/verified/morphz node scripts/runtime-computer-edge-smoke.mjs
```

The script creates an isolated temporary Runtime home/database, in-memory ephemeral Ed25519 fixture key and loopback deterministic provider. It exercises actual native pairing, signed challenge/connect, narrow Edge target heartbeat, claim, side-effect heartbeat and finish. Two native remote-target approvals are allowed once for this synthetic host tool. `ComputerApprovals` separately requires and records one explicit fixture `allow_once` decision for the exact counted click; no no-op act authorizer is used.

The next actual provider request contained the exact PNG as native `image_url` content, not a JSON/base64 text substitute. The continuation retained the same Principal, Agent, Context, Session, Thread and desktop target, verified through native job records and the public turn-to-Thread projection. One capture and one counted synthetic action occurred. The local host callback was never invoked. The final output committed, and duplicate input kept its original durable receipt.

Result: 3 loopback provider calls, 0 paid calls, 2 native approvals, 1 product action approval. The image/gesture driver was synthetic and had no real OS/display access. Temporary fixture state is removed after each run. The script does not pair a production device or change its credentials, start a VNC server, install software, or test the deployed isolation boundary.
