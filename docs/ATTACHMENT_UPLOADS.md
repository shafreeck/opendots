# Native staged attachment upload

Attachments use the existing, unmodified Morphz Session attachment-stage API. The product does not introduce Runtime endpoints, import arbitrary server paths, fetch user-supplied URLs, or treat a local write-tool file as a registered resource.

## What each state proves

- `pending` / `unknown`: the product saved a stable upload declaration; a native outcome may still be unconfirmed
- `uploading`: native staging has confirmed an offset. This does not mean the file was sent to the assistant
- `ready`: native staging verified the complete declared size and SHA-256. The bytes remain a draft, not a model input or Event-owned resource
- `consumed`: Runtime reported an immutable owning input Event. The input resource is projected through typed IO and can appear in the registered artifact catalog
- `missing`: the previously known stage expired or was removed. The product does not automatically replace it
- `cancelling` / `cancelled`: a user requested draft cancellation and its result is respectively uncertain/confirmed. Cancelling a stage cannot erase an already committed Event resource

Stage expiry must not erase a previously confirmed `consumedEventId` from the product projection. Native stage storage can expire while the immutable resource remains independently retained. None of these statuses alone claims that the model understood the file, completed a task, or delivered a result.

## Initial product limits

- Declared MIME allowlist: PNG, JPEG, PDF and plain text
- 10 MiB maximum per file; four files and 20 MiB maximum per draft
- 256 KiB maximum per upload chunk
- Stable lowercase SHA-256 required before creating the stage
- Filename only: no path separators, control characters or arbitrary source URL/path fields

The MIME allowlist is a declaration policy, not malware scanning or proof that arbitrary bytes decode as that format. Native import checks and provider/model attachment capability still apply. A successful stage does not prove every configured model supports that file type. Files are never executed, HTML-previewed or fetched by URL as part of upload.

## Identity and recovery

`AttachmentUploads` persists only upload declarations, native metadata and receipts in the product SQLite database. Raw file bytes are forwarded to the native stage and are not copied into product command/audit tables or another product file store. Native Runtime remains responsible for the stage bytes and lifecycle.

Each browser draft has one durable product draft key. The product derives a fixed native `client_message_id` from its saved user/Session binding and that key, and allocates each stage ID only once. Each file also has a stable upload idempotency key. Reusing a key with a changed declaration fails. Native stage ID, Principal and storage paths are not exposed in public upload views.

Every browser-facing upload/list/control action revalidates the fixed Runtime Principal and Session. Returned native stage metadata is checked against Principal, Session, stage ID, draft message ID, filename, type, size and expected digest. A stage or opaque resource identity is not additional read or send authority.

After an interrupted upload, the product reads the existing stage before writing again. Native `inspect` reconstructs the offset from the actual partial-file length, including after a Runtime restart. The next chunk must use exactly that offset. The product never guesses progress, automatically resends a chunk, or invents a new stage after uncertain delivery. A lost final response can be reconciled as ready only when native size and hash match. A hash mismatch remains unfinished and must not be submitted.

A previously observed expired/missing stage is not silently recreated. The user can explicitly remove the stale draft entry and select/upload a file again. Native default stage TTL in the pinned source is seven days, but the returned `expires_at` is authoritative because operators may configure a different TTL.

## Atomic chat submission

Selection/upload alone does not send a message or start inference. A normal user Send action supplies text, the stable chat command key, the draft key and ordered opaque upload IDs.

1. `prepareSend(draftKey, ids)` revalidates that each selected native stage is ready and returns the fixed `clientMessageId` and typed `attachments:[{stage_id}]`
2. The service creates the exact frozen chat payload, including text, order, upload IDs, stage IDs and client message ID
3. `RuntimeStore.prepare` starts one SQLite transaction, checks an existing command-key collision, and calls the synchronous `uploads.seal(draftKey, ids, commandKey, fingerprint)` callback before inserting the command
4. Seal and command persistence commit or roll back together. The seal binds one exact command key and content fingerprint; a different key cannot create a second command receipt for the same draft/native input
5. Only after that durable transaction commits does the existing dispatch path submit the typed IO message

A same-key retry reuses exactly the saved payload. A changed text, file selection/order or command key fails rather than silently changing an in-flight request. Existing non-attachment commands keep their original `command.id` native identity. No legacy inputs or accepted receipts are rewritten.

Once sealed, selected draft attachments cannot be cancelled or changed. A frozen command retains its exact references even if staging later expires; it must reconcile with the Runtime receipt/history rather than silently upload a replacement. This does not guarantee that an unaccepted command can succeed after its stage expires.

## Product HTTP surface

All mutation requests retain same-origin/Host checks and `x-opendots-csrf`. Identity and native stage IDs are never browser-selected. Query parameters are not accepted.

- `GET /api/uploads`: current product upload views plus product limits, after fixed-binding reauthorization
- `POST /api/uploads`: JSON `{draftKey,uploadKey,name,mediaType,sizeBytes,sha256}`
- `POST /api/uploads/:opaqueUploadId/content`: `application/octet-stream`, bounded bytes and `x-opendots-upload-offset`
- `POST /api/uploads/:opaqueUploadId/reconcile`: empty JSON object; reads actual native state
- `POST /api/uploads/:opaqueUploadId/cancel`: empty JSON object; explicitly cancels only an uncommitted draft
- `POST /api/chat`: existing `{text,idempotencyKey}` plus `{draftKey,uploadIds}` for an attachment-bearing message

The registered artifact download route remains separate and reauthorizes the immutable resource. A staging entry is never exposed as an arbitrary file download.

## Source and test evidence

Read-only upstream baseline: `7e8f7d81f8b00fd45544d94d5b9a321214633df1`.

- `morphz/src/web.rs`: official create/get/list/PUT-content/DELETE stage routes and exact offset header
- `morphz/src/sdk.rs`: Principal/Session authorization and stage command fields
- `morphz/src/model_input.rs`: exact declaration retry, filesystem-derived resume offset, SHA-256 verification, expiry and one-Event consumption
- `morphz/src/session_io/resources.rs`: `morphz.chat` JSON attachments accept exactly `{stage_id}` or `{resource_id}`; committed resources carry immutable Event provenance

Mock tests exercise lost create/final/chunk responses, restart resume, offset conflict, checksum rejection, foreign identities/drafts, expiry, consumed-resource preservation, cancellation, limits and atomic seal/command rollback. The adapter test checks encoded scope, fixed method/header behavior, no URL tokens and error-body redaction. The separate actual Runtime resource smoke exercises the pinned official binary; its result is reported independently rather than inferred from mocks. No paid model/provider call is required for these fixtures.
