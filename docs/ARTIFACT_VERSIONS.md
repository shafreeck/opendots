# Product documents and immutable artifact versions

`ArtifactVersions` manages named product documents whose versions reference
existing immutable native artifacts. It does not edit arbitrary bytes, crawl a
workspace, invent an IO resource ID, run a model, or ask Runtime to create new
content. Content is authored by ordinary tasks/uploads and registered through
existing native IO resources before it can be selected as a document version.

The module lives in `src/artifact-versions.ts`; the RuntimeService and BFF routes
are integrated. The Files UI is integrated with explicit confirmation and durable retry recovery. Documents, titles, notes, head revisions, immutable
version references and command receipts are **authoritative product records** in
the main RuntimeStore SQLite database. They are not rebuildable projections.
Backup/restore must retain all three tables. Native resource bytes remain owned
by Runtime and are not copied into this database.

## Constructor and authority

```ts
new ArtifactVersions({
  db: runtimeStore.db,
  binding: {ownerId: saved.userId, sessionId: saved.sessionId, verified: true},
  assertAuthorized, // synchronous current owner request check
  resolveArtifact,  // async NEW admission resource verification
  downloadArtifact,// async existing native artifact download
  now,             // optional injected clock
});
```

The service must derive the fixed binding from the already verified saved owner
and Session; request bodies cannot choose identity. The verified flag is a
required constructor assertion, not a new native authentication protocol.
`assertAuthorized` is mandatory and synchronous. Async/thenable guards fail
before admission; rejected guard promises are consumed. Local reads and old
receipt replay use current owner authentication without requiring Runtime to be
online. Live Principal verification is still required for new resource admission
and download.

For a **new** create/append, `resolveArtifact(id)` must refresh the existing
artifact catalog, reject stale/unavailable discovery, and call the existing
`downloadArtifact`/`Artifacts.download` path. That path verifies the native
Principal/Session and actual bytes, length and SHA-256 within its 32-MiB limit.
The resolver discards bytes and returns only `{sessionId, artifact: ArtifactView}`.
The module independently validates matching Session/resource identity, bounded
metadata and the registered product download path. Resolver failures commit no
document/version/receipt. There is no filesystem or model-text fallback.

After awaited verification the owner guard runs again inside the synchronous
SQLite transaction immediately before writes. This prevents a revoked browser
request from committing metadata after a slow native read. Shutdown closes new
admissions and awaits already-started read verification before the shared database
can close; uncommitted requests then fail closed.

## Operations and receipt semantics

- `create({title,artifactId,note?,idempotencyKey})` creates one document and its
  first version (revision 1, null parent)
- `append(documentId,{artifactId,note?,expectedRevision,parentVersionId,
  idempotencyKey})` appends exactly one successor and advances the head only if
  both the displayed current revision and parent version still match
- `receiptByKey(key)` returns the exact immutable committed receipt or null
- `list({limit?,after?})`, `get(documentId)` and
  `history(documentId,{limit?,after?})` read private product metadata locally
- `downloadVersion(documentId,versionId)` uses existing native download, compares
  the returned immutable provenance and actual bytes to the saved reference,
  then checks owner authority again before returning bytes
- `close()` stops admission and drains pending operations

Keys are 8–128 ASCII letters, digits, hyphens or underscores, globally scoped to
one product owner/Session across create and append. The normalized complete
command payload has a SHA-256 fingerprint. Titles trim surrounding whitespace;
notes default to an empty string and trim surrounding whitespace. Unknown
fields, supplied metadata/identity, control characters and oversized text fail.

An exact committed key returns its original receipt **before** current-head or
native-resource verification. This works after the head changes, a process
restart or native resource loss/offline state. Changed content under that same
key conflicts. A stale new key conflicts with the current head. Simultaneous
commands recheck key/fingerprint and head inside one transaction; only one
conflicting winner can commit. Product IDs are generated once at that successful
transaction and remain stable through the receipt.

The receipt is saved atomically with the version and head. An insertion failure
rolls everything back. Its `documentAtAdmission` is historical, not a fresh head;
read the document again for current state. `receiptByKey(key) === null` only means
no committed receipt was observed at that read. An earlier asynchronous resolver
may still complete later, so the UI must retain the same original key/payload
and must not treat absence as a definite rejection. No private title/note needs
to be stored in browser storage: an existing receipt contains the normalized
original input; when absent, exact reentry is required for a retry.

No rename, delete, overwrite, branching, merge, external sharing, secret handling
or arbitrary content editor is added. A title is fixed for this phase. Reusing a
known immutable resource under a new explicitly confirmed command is allowed;
its unchanged hash remains visible in the lineage.

## DTO and bounds

IDs use `doc-<UUID>` and `ver-<UUID>`; command IDs use `doccmd-<UUID>`.

```ts
Document = {
  id, title, revision, currentVersionId, createdAt, updatedAt
};
Version = {
  id, documentId, revision, parentVersionId, note, createdAt,
  artifact: {
    id, sessionId, sourceEventId, sha256, mediaType, sizeBytes,
    name, origin, createdAt
  },
  downloadPath: '/api/artifact-documents/:docId/versions/:versionId/content'
};
Receipt = {
  command: {id, key, kind, payloadFingerprint, input},
  documentAtAdmission: Document,
  version: Version
};
```

`command.input` contains normalized create/append arguments; append includes the
explicit documentId needed to recover its original route. Only the public
registered artifact ID is stored, not an opaque `io-resource:` identifier or
filesystem path. The Session, source event, hash, media, size and origin record
native provenance; the title and version note are product-owned.

Titles are 1–160 characters and notes at most 2,000. There are at most 200
documents per owner/Session and 1,000 versions per document. Pages default to 20
and cap at 50. Document list order is stable lexicographic document ID order.
Version history is always ascending revision with exact immutable parent IDs.

`list` returns `{documents,nextCursor}`; its `after` cursor is a document ID.
`history` returns `{document,versions,nextCursor}`; its `after` cursor is a version
ID belonging to that document. Foreign/unknown cursors cannot expose another
owner's records. Every local read and receipt lookup checks current owner access.
These pages are current reads rather than a multi-request snapshot; refresh the
first page to discover newly created document IDs before a previous cursor.

The implemented BFF route contract is:

| Route | Contract |
| --- | --- |
| GET `/api/artifact-documents` | Document list |
| POST `/api/artifact-documents/page` | `{limit?,after?}` |
| GET `/api/artifact-documents/:docId` | First history page with current document |
| POST `/api/artifact-documents/:docId/versions/page` | `{limit?,after?}` |
| GET `/api/artifact-commands/:key` | `{receipt: Receipt \| null}` |
| POST `/api/artifact-documents` | Create input |
| POST `/api/artifact-documents/:docId/versions` | Append input |
| GET `/api/artifact-documents/:docId/versions/:versionId/content` | Revalidated native bytes |

Module errors expose fixed `code` and `status`: invalid request 400; not found
404; request fingerprint/head conflicts and limits 409; foreign resource scope
403; invalid/changed/corrupt resource metadata/bytes 502; closed module 503.
Codes include `artifact_version_request_conflict`, `artifact_version_head_conflict`,
`artifact_version_not_found`, `artifact_version_invalid_request`,
`artifact_version_resource_scope_denied`, `artifact_version_resource_invalid`,
`artifact_version_resource_changed`, and `artifact_version_resource_integrity_failed`.
Existing resolver/download authority and native errors propagate to the service's
established error handling; they are never persisted as successful receipts.

A missing native resource does not remove product history or fabricate bytes.
Downloading an old version fails if the current native bytes are missing,
changed, corrupt or no longer authorized. Existing resource download behavior
remains the integrity and authority source; stored lineage is not a cached file.

## Durable schema

Ordered columns, retained by product backup:

- `artifact_documents(id,owner_id,session_id,title,revision,current_version_id,
  created_at,updated_at)`
- `artifact_document_versions(id,document_id,revision,parent_version_id,
  artifact_json,note,created_at)`
- `artifact_version_commands(id,owner_id,session_id,request_key,
  payload_fingerprint,receipt_json,created_at)`

Versions have unique `(document_id,revision)` and a document foreign key.
Command keys are unique per owner/Session. Appends do not update or remove prior
version rows or original command receipts. The document's head/revision is the
only changed lineage record.

## Module validation

The tests use the real existing `Artifacts` catalog/integrity code with synthetic
native transport and real SQLite. No model, network provider, real credentials or
native database access is used. They cover exact retries and changed payloads,
concurrent head/key conflicts, foreign/missing resources, verified bytes and
saved provenance, restart/offline recovery, ordered pagination, post-await owner
revocation, transaction rollback, invalid metadata, bounded text and shutdown.
Standalone module evidence is distinct from future BFF/UI or actual native-resource
acceptance evidence; no such integration is claimed by this module suite alone.

On 2026-09-30, all 17 standalone module tests passed, together with strict
repository TypeScript, module Node syntax and diff checks. BFF/UI integration
and any actual-Runtime resource acceptance must be recorded separately.


## Product integration evidence

The lead ran 30 HTTP/authentication/desktop-controller tests successfully. They
cover actual BFF create/append/history/receipt/download routes, inert response
headers, exact replay after a newer head and product restart, local reads while
native transport is unavailable, no new admission after failed native reads,
owner revocation during awaited resource verification, and the exact desktop
version-download route. These use synthetic native HTTP responses.

The extended `node scripts/runtime-resource-smoke.mjs` also passed against the
unchanged official pinned Morphz binary using a disposable local scripted
provider. An actually registered uploaded PNG and its actually registered output
copy became two explicitly linked versions, retaining different native source
Events and the same content hash. The exact version bytes, ordered history and
original admission receipt survived product restart and a newer document head.
There were two local scripted provider calls and zero paid calls. This proves
native-resource/product lineage wiring, not new image editing, real model
quality, external sharing or graphical client behavior. The integrated Files UI passed its focused behavioral regressions and independent
ordinary correctness review, including exact parent/revision confirmation,
unknown receipt recovery, reload reentry and late auth/modal responses. No live
browser pixel or native device validation is implied.
