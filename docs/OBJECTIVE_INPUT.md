# Exact Objective supplemental input

This feature uses the existing typed Session IO `activation.input_destination` contract from the pinned, unmodified Morphz Runtime. It adds human instructions to one exact continuing Objective. It is not global interruption, cancellation, automatic resumption, task-goal amendment, or creation of follow-up work.

## Native authority

The request is ordinary `morphz.chat` v1 JSON text with a stable `client_message_id` and this activation:

```json
{
  "mode": "evaluate",
  "dispatch_mode": "parallel",
  "input_destination": {
    "kind": "objective",
    "objective_id": "the-exact-selected-objective",
    "generation": 2
  }
}
```

The native contract can accept `reply_to_request_id` for an explicit answer to one current question. The current product keeps that action disabled because the pinned wait DTO does not supply the exact question text. Without it, the input is a supplement and does not claim to satisfy a pending question or release unrelated waits. No model, reasoning-effort, physical-target or Harness override is attached: directed input inherits the existing work route. Global `interrupt` and undirected `follow_up` are not used.

The Runtime validates the Principal/Session/Context, the Objective's current generation and active status, and the underlying primary Thread's open lifecycle/active control state in the same transaction that appends the accepted input and steering Signal. Primary Objective work must use `kind:objective`; direct thread steering of that primary execution is rejected upstream. The browser never chooses a Session or Principal.

## State and counters

- `generation` fences the executable lifetime. In the pinned source it advances when an Objective is explicitly resumed; ordinary accounting, leases or revision edits do not increment it
- `revision` is a different control counter. It remains visible for state/control UI but must not be substituted for `generation` in directed input
- `active` can include a deterministic `wait_condition`: user input, a timer, a tool, permission or other known dependency. Supplemental text preserves those waits
- `blocked` is not another spelling of waiting for user input. Native Objective updates reject `blocked` with a deterministic wait condition. Blocked and paused work require an explicit resume before new supplemental input
- Completed, cancelled, failed and unconfirmed/unknown Objectives are not eligible. Input is never silently converted into a new task

An available target is an advisory projection of current Objective state. The primary Thread may change between read and commit; native admission can still reject it. There is no new operator thread-detail read or arbitrary conversation-thread steering in this product feature.

## Exact question replies

Only a `wait_condition` whose `kind` is `user_input` and whose `session_id` matches the fixed Session can identify a current question. Its exact nonempty `request_id` is projected for diagnostic context, **not as an available reply action**. The pinned DTO has no question/prompt text; `status_reason` is generic lifecycle rationale and the latest chat reply is not an exact request-ID-to-content binding. Therefore `replyAvailable:false`, `questionText:null` and `replyReason:question_text_unavailable` remain explicit, and a submitted `replyToRequestId` is rejected. Ordinary supplemental input remains distinct and preserves the wait. For old rows without that field, the pinned native `steering::input_request_id` function defines the compatibility ID as `legacy:<objectiveId>:<generation>:<revision>`; no other question identity is guessed.

A changed/missing question, different Session or different generation fails rather than answering whichever question is newest. Native ingress also rejects a second independently keyed answer to a question that already has an accepted reply. The same accepted command may still be retried through normal idempotency.

## Product integration contract

`ObjectiveInput(binding)` is a pure validation/projection module. The host must supply an authoritatively read Objective and reauthorize the fixed saved Runtime Principal before dispatch.

- `target(objective)` returns `{objectiveId,generation,revision,status,available,reason,replyRequestId,replyAvailable,questionText,replyReason}`
- `prepare(objective,{text,idempotencyKey,expectedGeneration,replyToRequestId?})` returns the validated `{text,idempotencyKey,destination}`
- `LocalOperatorAdapter.sendObjectiveInput(sessionId,text,clientMessageId,destination)` requires native `directed_input:true` and emits the exact typed IO envelope

Proposed/host-wired routes are `GET /api/jobs/:id/input-target` and `POST /api/jobs/:id/input`. POST carries only `{text,idempotencyKey,expectedGeneration,replyToRequestId?}` with the existing same-origin/CSRF protection. The route must resolve the selected Objective from the fixed Agent/Context and require its coordinator Session to equal the saved Session. A non-null native initiating Principal must match the saved Principal; legacy null ownership retains native Session authorization rather than inventing an owner. Capability availability must also be checked before presenting the action.

The host stores an `objective_input` command containing exact text, Objective ID, generation and optional question ID before sending. New commands are validated against current target state; accepted or uncertain retries reuse their already frozen destination and client message ID. Do not refresh the saved generation, switch to another task, or replace a disappeared question ID on retry.

The native typed-IO implementation checks an existing receipt and request fingerprint before revalidating current work generation. Therefore a lost response can be reconciled with the same envelope even after the Objective later completes. A different payload under the same ID is an idempotency conflict, not permission to start another action.

## Receipts and errors

Native acceptance means the input was durably queued for that Objective. It is not proof the model has applied the instruction, completed the task, undone previous effects, or received new permissions. Existing physical actions are not implicitly cancelled. Changes apply at Runtime-safe boundaries; further output remains in the same conversation/task route.

- 400: invalid shape, text, command key, generation or question identity; no fallback send
- 403: wrong saved Agent/Context/coordinator Session or explicit Principal
- 409: stale generation, changed question, inactive/terminal target, duplicate question reply or disabled directed-input capability; keep the user's draft for review
- Transport failure/5xx: outcome unconfirmed; retain the durable command and retry/reconcile only the same envelope

Do not label an admission receipt “applied” or “task completed.” More detailed execution/application evidence requires subsequent native events.

## Source evidence and tests

Read-only baseline: `7e8f7d81f8b00fd45544d94d5b9a321214633df1`.

- `morphz/src/steering.rs`: typed destinations, route validation, exact question IDs and primary Objective routing
- `morphz/src/session_io/mod.rs`: `Activation.input_destination`, capability flag and rejection of route overrides
- `morphz/src/runtime.rs::send_io_as_principal`: existing-receipt/fingerprint check before new admission
- `morphz/src/memory/sqlite.rs::claim_message`: transaction-scoped Objective/Thread routing and duplicate-question fence
- `morphz/src/objective.rs`: active deterministic waits, blocked semantics and exact reply processing
- `application/packages/core/src/continuation.ts`, `application/packages/application/src/continuation.ts` and `runtime.ts`: existing application distinction between supplement and new follow-up work

The initial six module/adapter tests cover scope, stale generations, ordinary revision changes, active waits versus blocked/terminal states, exact/legacy question IDs, unsupported fields, capability gating and exact same-key typed envelope reuse. They use mocked transport. Live admission/application evidence is established by a separate actual Runtime fixture, not inferred from these tests.
