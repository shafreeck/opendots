# Generated product documents

This recovery restores private generated UTF-8 plain text, Markdown and CSV documents. They are product-owned bytes in the opendots SQLite store, separate from immutable references to Runtime artifacts. No Runtime code, database or event is modified; no external service or paid model is required.

## Authority and provenance

Only the explicitly configured `host_opendots_documents` native host tool can author. Browser endpoints are authenticated, read-only catalogue/history/download operations. A saved verified owner, Session, Principal, Agent and Context binding is mandatory. Owner authentication must be configured before enabling this tool.

The dedicated loopback listener rejects browser headers, verifies its distinct per-tool bearer token, and binds the exact callback path. Every new Call and every same-Call receipt replay independently verifies:

- Native Execution Job, Call, target-default route, Session, Principal, Agent, Context and Thread
- Native immutable request arguments after only the pinned Runtime routing additions are removed
- Exact Job membership in the exact Activation of that Thread's native snapshot
- Native Activation/root-turn identity and generation; new Calls require the current active generation
- When the Thread has explicit Objective supervision, the exact Objective and supervision generation against the supported bounded ContextScheduler endpoint

The pinned Runtime has no GET `/api/objectives/:id`; this product does not invent one. Missing Objective supervision remains null. A bounded scheduler response that cannot supply the exact explicitly named Objective denies admission rather than guessing. The version's provenance records jobId, callId, activationId, threadId, rootTurnId, threadGeneration, objectiveId/objectiveGeneration and all native identity fields. `rootTurnId` is the native causal Turn identity; no independent invented turn identifier is generated.

All provenance comes from server-side native reads. Model arguments cannot set identities, task associations, paths, URLs, credentials, approval flags or idempotency keys. A changed native provenance route cannot silently rebind an existing receipt.

## Tool interface

- `create`: name, format (`text`, `markdown`, `csv`), content
- `append`: documentId, expectedRevision, parentVersionId, content
- `list`: optional afterId and limit (1–20)
- `get` / `status`: documentId
- `history`: documentId, optional afterId and limit (1–20)

Create/append return `{document, version}` metadata with an exact immutable downloadPath. The host does not return document body bytes to models. A fresh status Call observes the current head; retrying an existing Call returns its original historical result even after later versions exist.

Limits: 160-character display name, 49,152 content UTF-8 bytes, 65,536 bytes for the complete serialized request/envelope, 200 documents, 1,000 total versions and 8 MiB total version content per owner/Session. Durable Call receipts are separately limited to 2,000 rows and 16 MiB of encoded result JSON per owner/Session; each receipt is limited to 256 KiB. New writes and read Calls atomically fail at receipt capacity without pruning prior receipts; existing receipts still replay. Because JSON escaping consumes space, a content string below its own byte limit may still exceed the encoded request limit. Controls other than tab/newline/carriage-return and malformed Unicode are rejected. Empty text content is valid. Binary, HTML format, filesystem import and cross-Session import are unsupported.

## Atomic immutable persistence

Document IDs use pdoc UUIDs; version IDs use pver UUIDs. Content is stored as literal UTF-8 bytes. SHA256 and byte size are computed from those actual bytes. Content, version metadata, head update and native Call receipt commit in the same SQLite transaction. Failed receipt insertion rolls all of them back.

Appends compare both the caller's reviewed parentVersionId and expectedRevision. Concurrent appends linearize one winner; losers receive an explicit head conflict. Same-Call changed arguments fail before mutation. Receipt replay ignores newer document heads but still checks fresh owner/native authority and exact saved provenance. Read APIs remain locally available during a Runtime outage; new native Calls and receipt replay fail closed without native authority.

The local request guard is synchronous and rechecked inside the transaction. Revocation or shutdown during asynchronous native verification cannot cause a late write. The host aborts and drains pending calls before its store closes.

## Retrieval integration contract

RuntimeService uses the verified saved product binding for local reads without requiring a live Runtime connection:

- `list({afterId?,limit?})` returns `{documents,nextCursor}`
- `history(documentId,{afterId?,limit?})` returns `{document,versions,nextCursor}`
- `downloadVersion(documentId,versionId)` returns `{document,version,bytes}` after recomputing the stored byte hash and size
- `forTask({objectiveId,jobIds,threadIds})` returns `{items:[{document,version}],truncated}` from exact immutable creator Job AND Thread evidence, never the current document head

Server routes must require the current owner cookie; POST pagination additionally requires the existing Origin/CSRF guard. No browser authoring route should be added. Native callback tokens do not authenticate browser reads.

Downloads must use Content-Disposition attachment with the fixed format extension, X-Content-Type-Options nosniff, Cache-Control no-store, a restrictive sandbox CSP and application/octet-stream delivery. Metadata retains the validated text media type. Do not render Markdown/HTML or execute content in the product. CSV contents are literal and may contain spreadsheet formulas; opening them in another application is the user's decision. Integrity mismatch returns an error rather than fabricated bytes.

## Explicit configuration and recovery

Version-2 host config supports `tools.authoredDocuments = {callbackToken, allowAuthoring:true}`. Its token must differ from other callback tokens and the Runtime operator token. `authoredDocumentRegistration` is a pure manifest-entry builder for `/api/host-tools/documents/call`. No credentials, host manifest or persistent access are automatically created.

ConfiguredHostTools retries failed native binding/listener startup with exponential delays from 250 ms to 30 seconds; successful readiness rechecks binding every five seconds. Closing cancels retries and prevents resurrection. UI authoring status can expose enabled, callbackListening, nativeRegistration and nextRetryAt without tokens. Saved history remains readable even when authoring is disabled.

The experimental version-1 product-backup helper already rejects unknown schema tables, including authored document tables. It has not been broadened, and must not claim a complete supported backup of this database family. Recovery of the repository itself is separate from product-data backup authorization.

## Tests

`node --test test/authored-documents.test.ts test/authored-host-service.test.ts`

These deterministic tests cover actual UTF-8/SHA256, three formats, immutable history, transactional rollback, CAS races, exact native proof and generation, old-Call replay, changed arguments/provenance, revocation/shutdown, local offline reads, corrupted bytes, owner isolation, file-backed restart and configured startup recovery. HTTP/browser and unchanged-Runtime integration tests are separate checks; passing this suite alone is not production or real-model acceptance.
