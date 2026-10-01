# Calendar reminders

OpenDots now stores explicit daily/weekly local-calendar intent and materializes
one future, undispatched Morphz one-shot schedule at a time. Morphz owns timer
dispatch and execution. Product SQLite stores recurrence intent and IO receipts;
it does not write native tables or infer completion of dispatched work.

## User/API contract

The existing absolute/fixed-second reminders remain separate. Calendar creation
requires an explicit preview and confirmation. These owner-protected BFF routes
use the existing CSRF/session gates:

- `POST /api/calendar-reminders/preview {rule}` returns up to three actual UTC
  instants with local dates, numeric offsets, overlap flags, skipped-gap dates,
  policy, calculation version, and `previewFingerprint`. This is pure calculation:
  no native request, model call, account probe or schedule is created.
- `POST /api/calendar-reminders {rule,idempotencyKey,confirmed:true,previewFingerprint}`
  admits a new series only if the preview still describes its next occurrence.
  HTTP 409 `calendar_preview_changed` requires a fresh explicit preview while
  retaining the original command key. HTTP 400 `calendar_confirmation_required`
  rejects missing confirmation. A previously admitted exact-key retry may omit
  the preview fingerprint; changed rule content is still a 409 conflict.
- `GET /api/calendar-reminders` and `POST /api/calendar-reminders/page {afterId?,limit?}`
  return `{series,nextCursor}`, with at most 50 series. List/history verify the
  current fixed native Principal/Session. They read stored UTC receipts rather
  than recomputing previews or dispatching new schedules.
- `POST /api/calendar-reminders/:id/control {action,expectedRevision,idempotencyKey,confirmed:true}`
  accepts pause/resume/cancel. The revision is the **product series revision**.
  Native schedule CAS revisions are saved and managed internally.
- `GET /api/calendar-reminders/:id/occurrences` returns the latest 20 occurrence
  receipts, including original local time, exact UTC and calculation version.
- `POST /api/calendar-reminders/reconcile {}` explicitly refreshes already-admitted
  recurrence intent and its native receipts. It does not create a new recurrence rule.

Create/control return a direct series view:

```ts
{
  id, revision, rule, desiredState: 'active' | 'paused' | 'cancelled',
  controlPending, ended, errorCode, recoveryDecisionRequired,
  createCommand: { idempotencyKey },
  latestControl: null | { idempotencyKey, action, expectedRevision, admittedRevision },
  occurrence: null | {
    id, time, state: 'pending' | 'unknown' | 'confirmed' | 'skipped',
    createAttempted, schedule, controlPending, errorCode
  },
  alreadyDispatchedWork: 'native_owned'
}
```

The authenticated view provides original command identities for retry after a
reload. Private intent text need not be stored in browser storage. A saved desired
state is not proof that native control has settled; `controlPending`, actual
schedule status and errors remain visible. The explicit product UI/API workflow
can also receive candidates from the opt-in [conversational calendar proposal
host](CALENDAR_PROPOSALS.md). That separately registered model tool can propose
rules; only an authenticated owner confirmation admits the persistent series.

`recoveryDecisionRequired` is true only for a confirmed external-control hold
whose native receipt is queued/paused/cancelled and has no unresolved native CAS.
It permits a fresh explicit decision at the displayed current product revision;
it is never true for an unknown create/control. A cancelled series permits only a
further cancel decision, not resumption. The UI must not choose recovery from the
old desired state alone.

## Immutable rule and timing policy

```json
{
  "intent": "Review the weekly plan",
  "timeZone": "America/New_York",
  "frequency": "weekly",
  "localTime": "09:00",
  "startDate": "2030-01-01",
  "untilDate": "2030-12-31",
  "weekdays": [1, 3],
  "dst": { "gap": "skip", "overlap": "earlier" },
  "missed": "skip_unsubmitted",
  "resume": "skip_overdue_paused"
}
```

`daily` omits weekdays; weekly weekdays are sorted, unique ISO values 1–7.
`untilDate` is optional and inclusive in the named timezone. Rules cannot be
edited after admission; create another explicit series for changed intent/timezone.
V1 supports dates from 2000 through 2099 and minute wall-clock times. It excludes
arbitrary cron, monthly rules, external notification channels and quiet-hour policy.

- A nonexistent local time is skipped, including a whole skipped date
- A repeated local time runs once, at the explicit earlier or later instant
- Never-submitted missed dates are skipped; there is no historical catch-up batch
- An already-admitted native one-shot can dispatch late while OpenDots is offline.
  The product does not claim to prevent that native behavior
- Pause stops successor creation immediately and requests native pause only while
  the current one-shot is queued
- Resume keeps a future paused occurrence. The explicit resume policy cancels
  and skips an overdue paused occurrence before advancing to the next future date
- Cancel stops successor creation and requests cancellation only for queued/paused
  schedules. Neither pause nor cancel rewinds a dispatched event or its work

Before first native create, and before a not-yet-attempted native resume, the
clock is checked again after asynchronous authorization. A request cannot become
overdue while waiting and then silently execute as catch-up. Once a resume's
outcome is unknown, its payload is never rewritten; an overdue unknown resume or
one superseded by pause/cancel remains unresolved without being replayed.

The implementation uses named-zone `Intl.DateTimeFormat` with ISO calendar,
Latin digits and `h23`. It exhaustively tests minute offsets from −24 to +24 hours
and requires an exact local-time round trip. There is a 32-day search horizon,
60,000 candidate-check budget, and maximum five preview occurrences. It does not
guess DST using fixed 24-hour/7-day durations. Each materialized occurrence stores
immutable UTC plus `opendots-calendar-v1`, Node, ICU and timezone-data versions.
Updated timezone data affects only future, not-yet-materialized occurrences.
See [ECMA-402 named timezone behavior](https://tc39.es/ecma402/#sec-use-of-the-iana-time-zone-database)
and [IANA timezone data](https://www.iana.org/time-zones).

Preview is an explicit UI action, never snapshot polling. Reconciliation yields
between series and persists a rotating cursor, so the first 50 rows do not starve
later series. RuntimeService checks for existing recurrence intent after normal
Runtime synchronization and starts a bounded reconciliation at most every 30
seconds. No extra native calendar request occurs when there are no stored series.

## Native authority and uncertain outcomes

Pinned unchanged source: `7e8f7d81f8b00fd45544d94d5b9a321214633df1`.
Only the existing session schedule POST/GET/control routes are used. Native create
deduplicates a stable schedule ID with its immutable request fingerprint.
Native pause is queued→paused, resume paused→queued, and cancel applies only to
queued/paused schedules. A dispatched one-shot is immutable. See
[native creation](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/runtime.rs#L3768-L3860),
[CAS controls](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/memory/sqlite.rs#L17199-L17339),
and [dispatch commit](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/memory/sqlite.rs#L18376-L18435).

Series IDs derive from fixed owner/session/create key. Occurrence IDs derive from
series/local date; overlap selection never produces two triggers for that date.
The exact UTC/request is committed before network dispatch and never recomputed
on restart. Every retry first reads the exact native schedule ID. Responses must
match intent, UTC, empty dependencies, no interval, revision, native thread and
`client-schedule-<id>` source identity. This module omits model/reasoning overrides;
the pinned native validation leaves an absent selection unchanged, so changing
the global default does not change this request fingerprint. Any actual upstream
identity conflict stays unresolved and never gets a new ID.

An attempted unknown create followed by 404 is **not** proof that it was absent.
While paused/cancelled or overdue it remains unresolved without a new create or
successor. A previously confirmed native schedule disappearing also stays held.
Only a never-confirmed, still-future, active create may be retried at its exact ID.
There is intentionally no destructive “forget uncertainty” recovery action.

Native control attempts persist action, exact expected revision, purpose and
attempted flag. An unknown CAS is resolved only by its expected next revision and
target status. A mismatched higher revision is held as external intervention;
an old command is not retargeted to a fresh native revision. Unexpected native
pause/resume/cancel/reschedule changes are exposed and not silently undone. A new
product command can acknowledge a newly observed compatible control state.

## Browser authority and lifecycle

RuntimeService captures the current owner-session assertion for each create/control,
then passes it explicitly into the module. Immediately before the SQLite intent
transaction writes, the assertion runs synchronously; returning a Promise fails
closed. Revoked browser sessions cannot admit new recurrence/control commands.
After durable admission, reconciliation runs outside the request's AsyncLocalStorage
scope, while its separate authorizer still verifies the fixed saved native owner
and Session. Logout does not silently cancel accepted recurrence work. A response
to the revoked browser is still withheld by the BFF's existing private-response guard.

Shutdown stops admissions and awaits both admitted operations and reconciliation
before closing shared SQLite. Native execution already dispatched remains owned
by Morphz. The module itself owns no execution timer or additional worker authority.

## Validation

The module suite has 24 passing tests, covering New York DST, Lord Howe's 30-minute
changes, Apia's skipped date, weekly dates, midnight and quarter-hour offsets,
durable IDs/UTC, restart, uncertain creates and controls, create/control races,
late authorization, out-of-band changes and synchronous admission guards.

Five executable BFF HTTP tests pass: private pure preview/confirmation, same-key
unknown-create recovery after application restart, revocation before admission,
logout after durable admission, and rotating reconciliation across 51 series and
restart. These use deterministic native transport fixtures and make no model call.
Strict TypeScript and changed-file Node syntax checks pass.

The optional actual-Runtime test also passed on 2026-09-30:

`OPENDOTS_RUNTIME_BINARY=/path/to/verified/morphz node --test test/calendar-native.test.ts`

It verified the unchanged official v0.1.3 binary with SHA-256
`29a5c5cb04cdc407858db04b49c5f52fd18892c831aad395e01cc3e4f172b8d3`, two real future
one-shots (daily and weekly) through the BFF, exact native `not_before` equality,
same schedule IDs after BFF restart and same-key retry, and native
pause/resume/cancel via product routes. There were zero due triggers, zero model
calls and zero paid calls. This proves native schedule API acceptance/lifecycle;
it does not claim a delivered reminder or actual due-time model execution.
The disposable process, listeners and temporary data were cleaned up. Default
tests skip this opt-in rather than starting Runtime implicitly.
