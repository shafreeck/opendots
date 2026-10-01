# opendots UI design and integration

2026-09-30 · functional shell implemented; visual draft still under review

Current user direction: retain the first richer layout, color and information density as the baseline; maturity means refined detail rather than sparse/minimal presentation. The second minimal concept was not selected. Use Muse as a reference for polished details, and preview typography/spacing/card improvements before stylistic integration; the current draft is not a final approved design. Functional behavior can continue independently.

## Direction

A continuous conversation, with visible work alongside it. Warm off-white surfaces, deep forest controls, pale lime emphasis and restrained cards. The default view is a conversation rather than an operations dashboard. No copied logos, characters or screenshot assets.

Public reference research inspected official marketing imagery, not authenticated app behavior:
- Dots: https://chatgpt.com/features/dots/ — compact conversation, status-bearing task rows, familiar file cards
- Meta Muse: https://ai.meta.com/muse/ — quiet conversational composition, goals/tracking, inline browser activity and open-browser affordance

The following are original proposals: two-column desktop workspace, forest/lime palette, ownership-controlled computer surface, explicit approval review, source-aware memory management, and BYOK settings. Reference observations are not claims about their internal implementation.

## Visual system

- Canvas #f6f7f4; surface #ffffff; primary text #182b28; secondary text #62716c
- Primary action #244c40 with white label; lime #d5f67b used sparingly
- Border #dde4de; soft surface #eef3e9; waiting/approval #fff1cf
- Text: system sans with Noto Sans CJK fallback; body 14px, supporting 12px, heading 29–34px
- 8/12/16/24/32 spacing rhythm; 9–16px corners; minimal shadows
- Visible keyboard focus, real button disabled states, native labels, dialog focus return, escape and tab trap
- Status always includes text; never color alone

## Information architecture

1. Conversation: persistent messages, composer and real runtime configuration/connection state; aside holds actual objectives, pending approvals and computer entry
2. Tasks: current state, revision, wait condition, pause/resume/cancel; external side effects are not presented as undoable
3. Artifacts: real registered resource catalog, integrity/source metadata and authenticated download routes; empty, stale and unavailable states differ
4. Memory: read-only official Frame search/read with source information. No manual memory editing or lifecycle controls; users correct information in conversation and the assistant maintains memory through existing Morphz capabilities. No Runtime modifications are included.
5. Computer: noVNC connection to the actual controlled gateway; unconfigured state has locked input and no pretend live stream
6. Models/settings: catalog, account binding, BYOK creation, explicit model selection; no automatic paid probe

## Responsive behavior

- Wide web: 216px navigation; conversation plus 390px contextual rail
- Medium: narrower navigation and rail; computer details stack
- Under 760px: single content surface; bottom navigation for conversation/tasks/computer/settings, composer remains in natural flow
- Desktop shell should reuse web view, adding OS pairing, local execution permissions and selected folder scope; it must not silently imply those capabilities are currently connected
- Mobile computer preview should retain same session ID and owner, support fullscreen and scaled coordinates, and visibly disable stale frames; transport implementation is outstanding

## Implemented real frontend contracts

- GET /api/state renders actual messages, objectives and approvals
- POST /api/chat and /api/jobs send unique idempotency keys
- POST /api/jobs/:id/control carries expectedRevision
- POST /api/approvals/:id/decision carries exact approval revision and allow_once/deny
- Every mutation carries x-opendots-csrf from state
- Untrusted model/tool strings are escaped; no browser-controlled principal/context/session identifiers
- GET /api/models; POST /api/models/select, /account, /connect
- API key is direct user input into password field, not stored in browser storage, not echoed, cleared on submission; account creation does not auto-bind or auto-select
- Configuration success explicitly does not claim a completed model inference test

## Live computer handoff acceptance contract

The UI now imports the locally served noVNC client and obtains short-lived gateway tickets for preview/takeover. Backend capabilities gate return-to-AI. Live external VNC pixel validation remains outstanding. Required states:
- disconnected/unconfigured: no live thumbnail, no claimed latency, input disabled
- AI controlling: view-only human preview of same headed browser session
- taking over: wait for server acknowledgement; revoke AI lease and fence queued commands
- human controlling: agent input suspended; no duplicate browser
- returning: capture fresh same-session screenshot/DOM before AI resumes
- lost connection: pause, retain session identity, do not replay submitted clicks or silently return control
- private entry: server must suppress frames, input and model observation; a frontend overlay alone is not privacy

Future transport must expose session ID, owner, epoch, last-frame freshness, connection state and uncertainty. Fullscreen and fit/1:1 scaling must preserve validated input coordinate mapping. Input channels must enforce the lease server-side. noVNC viewOnly is not a security boundary.

## Validation and limits

Passed: JavaScript syntax check; thirty-seven focused frontend tests plus six isolated audio-capture tests for all views, escaped input, CSRF/revision body, BYOK secret non-rendering and strict-CSP-compatible markup.

Pixel review remains unverified: local Chromium fails on process-singleton socket creation in this executor. Cloud browser rejects local file URLs and loopback HTTP. No screenshots are represented as verified renders. The design-only standalone HTML remains outside the product repo and contains labeled examples; the production public/ tree contains no sample conversation, sample files or pretend browser stream.

Not end-to-end verified by this frontend worker: actual Morphz model invocation, external visible VNC session, desktop shell, artifact download end-to-end and speech bridge. Other backend workers own Runtime validation. These are not claimed complete by this UI delivery.

## Review corrections

- Approval dialog snapshots exact displayed action and revision, preventing approval of newly polled unseen data
- Hash navigation survives server query rejection
- BYOK only persists a nonsecret request ID and configuration fingerprint in sessionStorage, scoped to runtime binding; keys and key hashes are never persisted
- Pending/submitting/unknown message attempts recover original durable command keys after reload
- Model selection explicitly changes the dedicated Runtime global default, including other inheriting sessions; local expectedCurrent is not upstream atomic CAS
- Native reminders require explicit RFC3339 offset and IANA timezone, show UTC confirmation, and label recurrence as fixed seconds, not calendar recurrence
- Streaming draft text is escaped and removed when the same root has a final committed response; no simulated typewriter
- Unknown objectives disable retained-revision control; paused/blocked objectives offer resume


### Runtime remains unchanged

User instruction prohibits Runtime code changes. The experimental custom memory editor has been removed from the product. Only existing official search/read APIs are used by the memory UI. Manual memory editing is out of scope; corrections belong in conversation. No capability probe or custom mutation endpoint is called.

### In-app inbox

Unread count and inbox read from the durable notification outbox. Users can acknowledge visible items, follow their task/approval/conversation targets, paginate, and turn in-app notices on/off. The UI explicitly describes local-inbox-only delivery, requests no system notification permission, and does not imply external messaging.

### Opt-in web voice foundation

GET /api/voice is configuration-only. Recording requires an explicit user click; stopped WAV audio stays in memory until a separate button authorizes transmission to the named configured provider/destination. Transcripts are editable previews and require another explicit durable-chat submission. Read-aloud only references committed assistant event IDs, with explicit text-transmission/cost disclosure. No automatic paid probes or retries, no duplex/phone/native-client claims.

The product-only AudioWorklet helper caps capture at 10 seconds by default (30 maximum), resamples mono PCM to 16 kHz signed PCM16 WAV, and releases microphone tracks on stop, cancel, setup failure, late permission cancellation, and capture limit. Navigation, modal replacement and pagehide also abort pending work, drop audio references, stop playback and revoke object URLs. Async modal request generations prevent stale memory/notification responses from hiding an active recording.

Browser API reference: https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack/stop . Real microphone hardware, provider billing, browser permission UX and audio playback remain unverified; mocks validate state/resource cleanup only.

### User-selected chat attachments

The user first selects files locally. Supported PNG/JPEG/PDF/plain-text files are bounded to 10 MiB each, four files and 20 MiB per draft. The client hashes bytes locally, then a separate explicit staging action transfers chunks of at most 256 KiB to the configured Morphz. Staging is not model submission. Send commits the exact ordered uploaded identities with the text and stable message key; background task attachments are not offered.

Only draft/command/upload identities and a bounded nonsecret definitive-rejection key/status marker are persisted in browser session storage, never bytes, filenames, hashes or message text. The marker is cleared before any retry; unknown outcomes never create it, and fresh server proof is still mandatory after reload. Reload matches product uploadKey to authoritative inventory. Partial transfers require reselecting the same file and verifying SHA, size, MIME and name; unknown writes reconcile the same identity, without automatic fresh staging. A confirmed pre-admission rejection can be unlocked only after explicit authoritative same-session/no-command/unsealed proof. Committed resources cannot be removed by cancelling an upload.

File picker/hash/transfer activity preserves the composer rather than allowing polling to replace the native file input. The user can stop a transfer and later reconcile, or cancel unsealed staging. Browser file picker/visual behavior is not yet tested with a real UI.

### Task-specific supplemental input

An active task offers a supplemental-input dialog after reading its actual input target. The dialog deep-copies the displayed Objective generation and uses one stable command key; polling never changes that target. Before the first network attempt, only objective ID/generation/key are saved in session storage. If reloaded before the server command is visible, the user must re-enter the original text using the same identity. Durable pending/submitting/unknown commands recover their exact original payload.

The UI never sends replyToRequestId for ordinary supplements and does not pretend to know question text absent from the native DTO. Supplementing does not resume a task, answer/clear a waiting question, globally interrupt work, or prove that the instruction was applied. A receipt means accepted/queued. Explicit re-targeting requires definite rejection plus a fresh authoritative check and user re-confirmation. Async completion cannot replace a newer voice recording dialog.

Local-only task input attempts remain reachable through “查看原请求” even when the task subsequently pauses or ends. This restores the original key/generation and does not enable a fresh supplement to an inactive task.

### Exact computer-action review

The chat and task views surface the server's `computerPendingApprovals` count. The review list reads `/api/computer/approvals`; opening an item deep-copies its action, screenshot path, observation, display dimensions, epoch and revision. It never swaps in a polled action while the user is deciding. The screenshot is explicitly an observed frame, not a live preview.

One-time approval remains disabled until the exact same-origin image loads with the expected dimensions and the item is actionable, pending and unexpired. Expiry is rechecked on every decision. Denial does not require an image. Only `{decision, expectedRevision}` is submitted; a stale or uncertain outcome is shown honestly and is not automatically retried. Close or replacement discards the image and action, without any decision or browser persistence. Asynchronous list requests cannot replace a later voice modal.

Copy distinguishes permission to send a physical input from evidence of external success, preserves prior-uncertainty warnings, and directs password/payment work to user takeover. No blanket approval is offered. The UI tests use synthetic fixtures; real-device image/capture validation and browser visual QA remain outstanding.

### Accepted visual refinement (2026-09-30)

The user provisionally accepted the refinement of the **first** warm-white/forest three-column direction. The pale-blue stripped-down Muse-derived mock was rejected and is not implemented. This is approval of visual direction, not completed pixel/runtime acceptance.

The shipped shell now preserves left navigation, the main conversation and the full task/computer/approval rail. The welcome heading has a restrained single-line hierarchy; line icons use a consistent local SVG stroke; task titles, statuses and actions have distinct spacing; shared-computer and approval panels have differentiated surfaces; the composer separates attachment/execution controls, the background-task option and its send button. No sample content from the preview is inserted into runtime state.

At intermediate tablet widths the rail moves below the conversation as a two-column panel group; narrow mobile retains its dedicated bottom navigation. Functional IDs, action attributes, permission checks and exact-revision/identity retry behavior are preserved. Reduced-motion settings disable decorative button transitions. Focused tests check the real controls and responsive rules; graphical browser rendering remains unverified in the current environment.

### Read-only connector inventory

Settings reads `/api/connectors` only for its initial connector panel. It lists the configured public repository policy and public-read operations, explicitly without account connection. A ready callback listener is not shown as a successful GitHub connection. Disabled/error states clear stale operation inventory.

`/api/connectors/native` is called only by the explicit “核对 Runtime 声明” button. Its result is labeled declared execution-target evidence, without connection verification or native operation schemas. It never invokes the private callback listener or an external GitHub probe. The panel has no secret, manifest, repository-policy or permission editing form. Request generations and captured owner/binding identity prevent late responses from repopulating state after logout or session changes.

### Calendar-aware daily / weekly reminders

The task view adds a separate local-calendar form while preserving the existing fixed-second reminder workflow. Users specify IANA timezone, HH:mm, start/end dates, daily/weekly frequency, sorted ISO weekdays and earlier/later overlap policy. Preview is an explicit POST that performs pure time calculation; no model call. The confirmation shows the normalized rule and UTC occurrences, offsets, skipped gap dates and calculation version.

Create requires a second explicit confirmation. Copy explains DST gaps skip, overlaps choose one occurrence, missed never-submitted dates skip, already-admitted native schedules may arrive late, and resume skips overdue paused occurrences. Every trigger uses the then-current configured model and may incur provider charges. No model-callable calendar tool or automatic paid test is claimed.

Inventory and occurrence history show stored instants, native schedule state and **desired** series state separately. Pause/resume/cancel confirms a frozen series version; already dispatched work cannot be recalled. Reconcile is an explicit confirmed action and never called by polling or list refresh.

Session storage contains only the attempt key, opaque preview fingerprint, or control series ID/action/version. It never stores reminder intent. Unknown create reload recovers the rule from authorized series inventory through its create command key; if not yet visible, the user re-enters the original rule and previews again with the same original key. Existing admitted exact-key requests can recover receipts without generating a new preview. Unknown controls retain exact key/action/version. Stale previews require renewed preview consent without changing identity; a definite control revision rejection requires a new user decision against refreshed state. Backend same-key conflicts remain authoritative. All continuations respect auth/modal generations.

Confirmed external native-control holds use the backend's narrow `recoveryDecisionRequired` projection. Only that capability enables a new explicit decision at the displayed series revision; the dialog shows the observed native state. Active/paused series offer pause/resume/cancel independently of old desired state. Cancelled series allow only cancel. Unknown creates or in-flight native controls remain blocked; error strings alone never enable recovery.

### Conversation-generated calendar proposals

The chat/task attention banner uses the stored pending proposal count, independently of assistant replies. Task inventory lists durable proposal status with job/call/thread provenance; candidate creation is explicitly **not scheduling success**. Initial list and pagination read stored data only. Owner authentication is required for this feature.

Only opening a pending proposal requests a fresh preview at its displayed revision. The review shows its immutable rule, actual fresh UTC occurrences, overlap/gap policy, calculation version and model-cost notice. Historical previews are never used to enable confirmation. A separate explicit owner confirmation sends the original revision and rule/preview fingerprints; the server derives the single proposal command identity. No approval or preview polling is performed.

Unknown confirmation can be retried against the same frozen proposal or reconciled with its status endpoint. An admitted result points to normal series controls, and its stored candidate time is labeled separately from preview time, with pending/unknown/skipped/confirmed state and any actual native receipt status. Reloading an admitted proposal does not re-preview or schedule again. Dismiss-after-admission directs the user to cancel the actual series; dismissed proposals cannot be revived. Stale preview/revision requires opening a new review and renewed consent. Repeated clicks, late responses, navigation and changed auth/binding identity cannot reuse old consent. Proposal text is not persisted in browser storage.

Saved conversational proposals remain reviewable when new host proposal creation is disabled. Navigation invalidates outstanding modal opens even before a modal is visible; a delayed detail/preview cannot revive abandoned consent on another page.

### Named artifact documents and immutable versions

Files now separates named documents from the existing registered native-resource catalogue. The owner may register an existing resource under an immutable document title, or append another known resource to an exact displayed document revision and parent version. The editor accepts only title/note metadata and resource selection, followed by a separate target/provenance confirmation. It cannot edit arbitrary bytes, native files or sharing permissions.

Document history remains readable when the Runtime is unavailable. It shows immutable parent lineage, resource session/event/hash, MIME/size/origin and version notes. Version downloads only accept exact same-document `doc-UUID/versions/ver-UUID/content` paths and continue to require server-side native authorization and hash checks. Older admission receipts are explicitly distinguished from the current head.

Unknown outcomes retain a single key, target, resource and expected revision/parent. Browser storage holds only those retry identifiers, never private titles/notes/bytes. Receipt lookup resolves committed attempts without replay; absent receipt is not treated as failure. Before receipt appears after reload, the owner must re-enter the original title/note under the same fixed key and target. A definitive head conflict may explicitly reload the head for a fresh confirmation with the same key; no mutation occurs during refresh and same-key conflicts remain server authoritative. Auth/modal/navigation generations fence delayed results and abandoned consent.

### Opt-in streaming dictation

The existing one-shot recorder remains available. Streaming is offered only when `/api/voice.stream.available` and `streamingDictation` are true. The user first chooses the mode, then explicitly consents to ongoing microphone transmission to Doubao at openspeech.bytedance.com and possible charges. No mic, provider connection or probe starts on load or mode selection. This is single-direction dictation (`duplex:false`), not a phone/full-duplex session.

The separate capture helper produces bounded mono16k PCM16 frames. UI sends one sequence at a time (at most 6400 bytes/frame), never retries audio, and uses revisioned server snapshots for partial text. Read long-polls continue during graceful Stop: local capture releases the mic and drains sends, then the provider receives finish; no active HTTP request is aborted during that path. Only final text enters the existing editable unsent transcript confirmation, preserving ordinary chat retry identity. Stopping dictation does not stop model tasks.

Cancel, backgrounding, navigation, modal replacement, logout/session change, network failure and late permission/import races stop tracks, abort in-flight calls, discard partial audio/text and best-effort cancel the original stream UUID. The server tombstone prevents delayed opening, and session revocation closes the stream. There is no automatic reconnect, chat submission or TTS. UI tears down other audio modes; the backend independently holds one speech-provider operation per Principal until actual close, and an uncertain close may reject a later operation as busy rather than overlap it. Busy failures are not automatically retried.

The configured maximum defaults to 60 seconds with a 120-second hard cap. UI also accounts for the server's remaining lifetime so capture can drain before expiry. Audio and transcript remain transient; provider retention follows its policy. Helper, HTTP and UI fixture tests are separate from real microphone/provider/graphical validation, which remains unperformed.

A server-initiated finishing state also releases capture promptly and discards queued unsent frames without aborting its read request. A race where an already-sent frame is rejected as not-listening during that known finishing state is not retried or treated as a reason to discard the eventual final transcript. Oversized reviewed text (>4000 characters) stays editable with a shorten instruction before any chat key is frozen; it is never silently truncated.
