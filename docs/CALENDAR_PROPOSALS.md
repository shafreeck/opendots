# Conversational calendar proposals

OpenDots can expose `host_opendots_calendar` to an unchanged Morphz Runtime. The
model can list product series/proposals, preview a daily or weekly rule, propose
it, and inspect its later status. A successful proposal creates **no recurrence
and no native schedule**. The authenticated owner reviews an explicit fresh
preview and confirms in the product UI before the existing calendar admission
path can create a series. This is an opt-in configured integration.

This guarantee applies to this OpenDots host tool and its browser endpoints.
Morphz's existing `schedule_tx` tool, including `every_seconds`, remains unchanged
and is outside this product host's confirmation guarantee. This integration does
not provide a global prohibition on every native scheduling capability.

## Source-backed native contract

The implementation follows Morphz source commit
`7e8f7d81f8b00fd45544d94d5b9a321214633df1`:

- `morphz/src/host_tools.rs:40–70` defines explicit manifest registration,
  context allowlists and trusted retry selectors. The product builder uses an
  empty `idempotent_requests` list and no context wildcard.
- `host_tools.rs:357–435` constructs protocol-1 callback envelopes from the
  Runtime-owned ExecutionJob, posts to a registered numeric-loopback endpoint
  with its bearer, and returns JSON as tool-result text. It does not produce a
  `UserInput` event or grant browser approval authority.
- `morphz/src/tool.rs:600` defaults generic tool approval requirements to none;
  HostTool does not override that method. Native Job success means the proposal
  tool completed, not that a human approved persistent recurrence.
- `morphz/src/web.rs:1298–1305` exposes the supported ExecutionJob read API. The
  existing supported context Thread, Session and Session Principal reads provide
  the remaining native authority checks.
- `morphz/src/tool.rs:4475–4573` exposes native `schedule_tx` recurrence. It is not
  modified or intercepted here.

`NativeHostAuthority` is pinned by trusted constructor configuration to exactly
one of `host_opendots_connectors` or `host_opendots_calendar`. Before every fresh
call and replay, it verifies the saved Principal/Agent/Context/Session, exact
Job/Call/Thread/target identity, pinned native tool name, and exact native
arguments after removing only the known Runtime metadata fields. Fresh calls
also require a running, uncancelled Job and open active Thread. The only allowed
target is `target-default` with the `in_process_local` route.

These supported native reads are not an atomic lock against a concurrent native
cancellation. A cancellation after the last proof can leave a pending candidate;
it still cannot create a calendar series or substitute for owner confirmation.

## Explicit configuration and one listener

Select one private configuration file using `OPENDOTS_HOST_TOOLS_CONFIG`.
`OPENDOTS_CONNECTOR_CONFIG` remains a compatible legacy flag; supplying both is
an error (`host_tools_config_ambiguous`). Existing version-1 connector JSON is
accepted unchanged. No automatic migration, discovery, token generation,
manifest writing or pairing occurs.

Version 2 has independent entries. Omit either entry to disable that tool:

```json
{
  "version": 2,
  "ownerId": "SAVED_PRODUCT_OWNER_ID",
  "runtimeOrigin": "http://127.0.0.1:3000",
  "binding": {
    "principalId": "SAVED_NATIVE_PRINCIPAL_ID",
    "agentId": "SAVED_NATIVE_AGENT_ID",
    "contextId": "SAVED_NATIVE_CONTEXT_ID",
    "sessionId": "SAVED_NATIVE_SESSION_ID"
  },
  "callbackPort": 4401,
  "tools": {
    "githubPublic": {
      "callbackToken": "EXISTING_SEPARATE_GITHUB_CALLBACK_TOKEN",
      "allowPublicGithubReads": true,
      "repositories": ["morphz-ai/morphz"]
    },
    "calendarProposals": {
      "callbackToken": "EXISTING_SEPARATE_CALENDAR_CALLBACK_TOKEN",
      "allowProposals": true
    }
  }
}
```

These are placeholders, not credentials. The operator must supply existing
explicit private configuration and a previously verified saved binding. The
file reader requires a current-user-owned regular single-link file, 0400 or
0600, at an absolute trusted path, with no symlink and at most 16 KiB.

Enabling calendar proposals additionally requires configured owner browser
authentication. Startup fails without it. Loopback location or a CSRF token alone
is not treated as a human identity. Callback tokens must differ from one another,
the Runtime operator token and the owner login credential.

One `NativeHostListener` serves both exact routes on `127.0.0.1`:

- `/api/host-tools/connectors/call`, with the connector token/tool identity
- `/api/host-tools/calendar/call`, with the calendar token/tool identity

Each accepts only its own token, exact POST path, and bounded JSON. Browser
Origin/Cookie/fetch metadata/CSRF headers are rejected on this listener. Native
bearers do not bypass authentication on the main product listener. The GitHub
adapter retains its existing `public_read` classification; proposal writes use a
separate host. Configuration/status reads make no GitHub or model request.

The pure `calendarProposalRegistration({contextId, endpoint, token})` builder
returns a protocol-1 manifest entry with the exact calendar path and explicit
context ID. It never writes a manifest or changes a running Runtime. The operator
must register the entry through Morphz's existing host manifest setup and restart
that Runtime as appropriate. Configuration alone does not prove registration.

Configuration and saved binding are rechecked before native dispatch and replay.
A changed file stops new host work. Historical candidates remain available to
the authenticated owner when the host is disabled. Shutdown stops admission,
aborts requests and awaits their actual handlers before closing shared SQLite.

## Model-facing operations

| Action | Allowed input | Result |
| --- | --- | --- |
| `list` | `kind: series\|proposals`, optional `afterId`, `limit` 1–20 | Bounded product inventory |
| `preview` | Complete calendar `rule` | Pure upcoming dates and explicit policy; not admitted |
| `propose` | Complete calendar `rule` | Durable candidate requiring owner review |
| `status` | Product `proposalId` | Current proposal and admitted series projection, if any |

Unknown fields and actions are rejected. There is no model argument for owner,
identity, credentials, confirmation, approval, create/control, arbitrary native
endpoint or caller idempotency key. The host is not given a native schedule
adapter or the owner's calendar admission/confirmation methods.

Rules use the existing [calendar reminder contract](CALENDAR_REMINDERS.md): daily
or weekly, IANA zone, local wall clock, start/optional end date, explicit overlap
choice, skip nonexistent times, skip unsubmitted missed occurrences and skip
already-overdue paused occurrences on resume. No cron, monthly or external
notification channel is added. Proposed text is untrusted model output and is
shown as text for owner review.

## Durable candidate and owner decision

The product stores proposal identity derived from fixed owner/Session/tool and
the verified native Job/Call. It stores immutable normalized rule/hash, proposal
preview/calculation version, and verified Job/Call/Thread provenance. This proves
the tool invocation source, not that the model's proposed text was authored or
approved by the human.

At most 20 pending proposals and 200 total proposals per owner/Session are
accepted; exceeding either bound fails explicitly. Lists have at most 20 entries,
stored previews are bounded and native result receipts are limited to 256 KiB.
No automatic deletion of decisions or proposals occurs. The original tool result
is immutable: replaying a completed old Call still returns its original pending
result even after admission/dismissal. A new `status` Call observes the current
snapshot and gets its own immutable receipt. Private proposal text/results follow
product database access controls; no credentials, raw errors or proposal contents
are logged by these modules.

The proposal view distinguishes:

- `pending_owner_confirmation` + `scheduling: not_admitted`
- `dismissed` + `scheduling: not_admitted`
- `admitted` + `scheduling: series_admitted` + `seriesId`

Admission does not imply a native schedule receipt. Current series projection
separately reports pending/unknown/confirmed occurrence and actual native state.
An unknown create remains unknown until existing calendar reconciliation reads
back the fixed native schedule ID. It must not be presented as an actual next run.

Owner confirmation derives a fixed create key from the proposal ID. Inside the
existing `CalendarReminders.create` SQLite transaction, the synchronous guard
rechecks the current browser authority, displayed proposal revision/rule hash,
and fresh preview. Proposal CAS and series insertion commit atomically. Failure
of series insertion rolls both back. Native schedule submission follows durable
admission, using the existing calendar unknown/reconciliation behavior.

Exact confirmation retries after a lost response reuse the original displayed
revision/hash and fixed series key, including after restart; they do not require
another fresh preview once the same series was admitted. A newer/stale candidate
or changed rule cannot create a second series. Dismiss wins only before admission;
a dismissed proposal never revives. Dismiss after admission returns a conflict
and directs the owner to the ordinary series cancellation workflow, which cannot
undo native work already dispatched.

Browser logout before the transaction blocks admission. Logout afterward cannot
silently cancel the accepted recurrence; its private response is withheld while
fixed saved native authority continues admitted reconciliation outside request
AsyncLocalStorage. No native tool result is fabricated into a chat event or a
`UserInput` question. The durable proposals UI/count is the review channel.

## Browser API

All routes use existing owner sessions, mutation Origin/CSRF checks and private
response revalidation. Proposal status/list remain readable after the originating
native Job completes; they do not require the original tool Job to remain live.

| Method/path | Body/response |
| --- | --- |
| GET `/api/calendar-proposals` | `{enabled,pendingCount,proposals,nextCursor}` |
| POST `/api/calendar-proposals/page` | `{afterId?,limit?}` → same bounded inventory |
| GET `/api/calendar-proposals/:id` | `{proposal,series}` |
| POST `/:id/preview` under that prefix | `{expectedRevision}` → current preview, proposal revision/hash |
| POST `/:id/confirm` under that prefix | `{expectedRevision,ruleFingerprint,previewFingerprint?,confirmed:true}` → `{proposal,series}` |
| POST `/:id/dismiss` under that prefix | `{expectedRevision}` → `{proposal}` |

`GET /api/state` includes cheap saved `calendarProposals:{enabled,pendingCount}`;
it does not recompute previews on polling. Preview is explicit. First-admission
stale previews return 409 `calendar_preview_changed` without modifying the
proposal. Revision/rule conflicts return `calendar_proposal_revision_conflict`;
dismiss-after-admission returns `calendar_proposal_already_admitted`.

## Evidence

On 2026-09-30, 6 proposal-store tests and 3 native-host authority fixtures passed,
including transaction rollback, exact retry, bounds, rejected async guards,
forged arguments/identity, and historical replay versus fresh status. The 24
existing calendar lifecycle tests also passed after the synchronous admission
hook extension.

Ten dedicated executable HTTP tests passed against the actual shared listener
and BFF with deterministic native transport: bearer/path/tool separation, owner
login requirement, model approval rejection, native proof, config revocation,
unknown receipt/restart recovery, concurrent confirm/dismiss and duplicate
confirmation, browser revocation before durable admission, stale preview,
immutable old Call/fresh status, and shutdown drain. The independent review
repeated the frozen integration tests. These are local contract/race fixtures,
not evidence of a live model provider or native scheduling execution.

The optional actual-Runtime test is `test/calendar-proposal-native.test.ts`:

```sh
OPENDOTS_RUNTIME_BINARY=/path/to/verified/morphz node --test test/calendar-proposal-native.test.ts
```

It verifies the official unchanged v0.1.3 binary hash, uses a disposable local
model with `auth_adapter="none"`, and requires an actual Runtime-owned tool Job
and callback before an authenticated owner confirms one future occurrence.
Its execution result is recorded below separately. Default tests skip the native
process unless explicitly selected. The fixture cleans up its process, listeners
and temporary configuration. It makes no paid or external-provider request.

The actual native test passed on 2026-09-30. The real host Job succeeded and its
pending tool result reached the next model call; an assistant reply was committed
through native IO. Two deterministic local model calls occurred. There were zero
product native schedule-create requests before owner confirmation and exactly
one afterward; its actual queued receipt matched the preview UTC. A BFF restart
and exact confirmation retry retained the same series and native occurrence IDs.
Replay of the original completed Call still returned the historical pending
proposal. There were zero due triggers and zero paid calls. This is native
proposal/admission/lifecycle evidence, not natural-language understanding or a
real-provider evaluation. A separate due-delivery test covers scheduled output.

During fixture setup, a non-hex synthetic login credential was correctly rejected
and an unsupported schedule-list GET returned 405. The final fixture uses the
required 64-hex disposable login token and source-supported per-ID schedule GET,
with instrumentation of the real outbound schedule-create requests. Product
authentication and native APIs were not relaxed or changed to pass the test.

Final application aggregate after the proposal UI/integration and bounded list
fix: 431 tests total, 426 passed, 5 intentional opt-in/platform skips, 0 failures.
Strict TypeScript, changed-file Node syntax and diff checks passed. The native L2
pass above was an explicit additional run, separate from those default skips.
