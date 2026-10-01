# Product database backup and recovery

Experimental, opt-in tooling: ordinary fixture tests pass, but final independent
security review is incomplete. It is not enabled in the application and has not
been accepted for a real private-data recovery operation.

## Scope and current limits

The Linux/Node 24 CLI snapshots one **explicitly selected main product SQLite
database** into a new private directory, verifies its SQLite integrity and
SHA-256 manifest, and restores it only into another new private directory.
It does not stop or start the application, alter configuration, connect to
Morphz, replay a command or replace an existing database.

This is not a complete system backup. It excludes:

- Morphz Runtime databases, native execution state, credentials and model accounts
- External artifact/attachment bytes, remote services and external effects
- Operator auth/provider/connector/computer configuration files and environment
- The separate `${OPENDOTS_DB_PATH}.computer` control/lease/epoch database

The last filename is literally the main database path plus `.computer`; it is
not necessarily a filename ending in `.computer.db`.

The main product DB **does contain** `computer_edge_journal`, observation metadata
and product action-approval records when those features are configured.
`ComputerHost` supplies `runtime.store.db` to those components. They are retained
in the snapshot, alongside conversations, binding, command receipts, calendar
series/occurrences/proposals, attachment metadata, connector receipts,
notifications and artifact document/version references. The separate computer
DB holds `ComputerControl` state and its audit, not that main-DB Edge journal.

An older product snapshot cannot rewind Morphz or any external effect. Missing
operations in an old image are **not evidence that they never happened**.
Normal startup can re-read current native state, but cannot recover command
intents or product receipts created after the snapshot. Do not casually mix,
move or restore the separate computer-control DB, or assume a restored older
Edge journal contains all completed physical actions. Computer recovery and
cross-component consistency require a separate review before enabling execution.

## Privacy and prerequisites

Snapshots contain private conversation content, user/session identifiers,
authentication session hashes, credential-configuration fingerprints and other
persisted product state. They may contain sensitive text originally supplied in
a conversation. The tool does not attempt to find or redact such text.
The versioned manifest contains time, hashes, file size and an authentication
mode indicator; it omits source paths, plaintext owner IDs and conversation data.
Treat the entire directory as private. Do not publish it, commit it to Git or
attach it to a support issue.

The source must be a private, current-user-owned ordinary single-link file,
readable by its owner, with no group/other permissions or executable/set-ID bits.
Selected paths must be explicit, absolute and normalized. Symlinks, hard-linked
database inputs, unsafe existing SQLite sidecars and untrusted writable parent
directories are rejected. Existing source permissions are never changed.
The normal product CLI starts with `umask(077)`; an older/imported permissive
database can therefore produce `backup_file_unsafe`. Stop and review that file's
ownership/permissions separately rather than expecting this tool to repair it.

Destination parents must already exist and be trusted. Each destination
directory must be unused; the tool creates it with mode `0700` and files with
mode `0600`, without changing the process umask or existing filesystem settings.
The current implementation requires Linux, `/proc/self/fd`, Node 24 with
`node:sqlite.backup`, and the known runtime-product schema. Demo databases,
arbitrary SQLite databases, unknown manifest versions, nonzero SQLite
`user_version`/`application_id`, unknown tables/columns, views, triggers and
virtual tables are rejected. New product schema requires an explicit tool update.
The current artifact document/version/command-receipt tables are supported.

## Snapshot and verify

Run from the repository with explicit operator-selected paths:

```sh
node scripts/product-backup.mjs snapshot \
  --source /absolute/path/to/opendots.sqlite \
  --destination /absolute/private/backups/new-snapshot

node scripts/product-backup.mjs verify \
  --snapshot /absolute/private/backups/new-snapshot
```

These commands are examples; no production database or operator path was used
to validate this implementation. There is no HOME scan, default database path,
credential discovery, cloud upload or automatic retention/deletion policy.

A successful snapshot contains exactly:

```text
new-snapshot/
  product.sqlite
  manifest.json
```

The supported [Node SQLite backup API](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)
captures a coherent committed image, including committed WAL data. It does not
copy the main file while forgetting its WAL. The source is opened read-only;
no application/service constructor or Runtime adapter is started by the tool.
The new copied DB is normalized to self-contained DELETE journal mode before
hashing and publication. SQLite's own temporary sidecar handling remains part
of SQLite I/O; there is no application-row mutation of the source.

The application may keep writing during this single-database snapshot. SQLite
can restart its backup if another connection modifies the source. A changing
source does not imply a global point-in-time image of product DB, computer DB,
Runtime and external services. The tool bounds database size at 512 MiB and
checks a two-minute bound during backup progress; a busy/failed operation can
leave an incomplete private output directory.

Verification checks the fixed file list, bounded manifest, SHA-256/length,
SQLite integrity/foreign keys, known schema and saved product identity. A hash
detects corruption relative to its manifest; it is **not authentication** if an
attacker replaces both files. Use only snapshots whose custody you trust.

## Restore into a new location

First stop the product application and its product workers through their normal
operator workflow. This tool does not discover processes or prove they stopped.
Then explicitly acknowledge that condition:

```sh
node scripts/product-backup.mjs restore \
  --snapshot /absolute/private/backups/new-snapshot \
  --destination /absolute/private/recovery/new-restore \
  --app-stopped
```

`--app-stopped` is an operator declaration, not permission to replace a live
database. Restore refuses every existing destination, including the original
database, a previous restore, an existing empty directory and a symlink.
There is no force, overwrite, in-place rollback or origin-rebinding option.

A successful restore contains `product.sqlite` and `restore.json`. The receipt
records the input/output hashes, invalidated device count and
`reconnectPerformed:false`. The original snapshot remains unchanged. The tool
does not select the restored path in application settings or start the app.
Before manually selecting the new path, review identity/origin/configuration,
native history, any operations after snapshot time and the separate computer
state. Do not treat this recipe as authorization to resume external execution.

### Owner sessions cannot be resurrected

In a snapshot with owner authentication, the restore transaction:

1. Deletes every `auth_device_sessions` row in the **new copy**
2. Increments `auth_owner_state.generation`
3. Retains `owner_id`, `origin`, `config_hash` and rate-limit attempt history

Those fields correspond to the current `OwnerAuth` implementation. Old cookies,
including cookies revoked after the snapshot, cannot authenticate the restored
copy. A new login must use the separately supplied current operator auth config.
The credential itself is not obtained or generated by the tool. Original source
and snapshot sessions are not modified by restoration.

The saved product owner, Principal/Agent/Context/Session binding and Runtime
origin are preserved byte-for-byte. HTTPS versus loopback authentication-origin
binding also remains unchanged; the normal application's fail-closed origin and
identity checks still apply. Restore is not an origin migration workaround.

A snapshot taken before owner authentication was ever configured preserves that
historical unauthenticated state. It cannot attest whether authentication was
enabled after the snapshot. The operator must review current security
configuration before starting any restored copy.

### Commands and uncertainty

The tool preserves command IDs, idempotency keys, payloads, attempts, statuses,
native IDs, receipts, history and cursors. It does not claim uncertain work failed
or generate replacement command identities. On normal `RuntimeStore` startup,
saved `submitting` commands become `unknown` with `host_restarted`, exactly as
ordinary process recovery already does. Existing `unknown` commands and calendar
occurrence uncertainty remain intact. A pending/native receipt is not replayed
by the backup tool.

## Failure behavior and filesystem boundary

SQLite's backup function can overwrite an existing pathname. This tool therefore
uses only a newly created private staging directory. It pins that directory
with `O_DIRECTORY|O_NOFOLLOW` and performs SQLite/staging/publication/manifest I/O
through a descriptor-relative Linux path, so renaming the selected directory
does not redirect subsequent writes into its replacement. It checks original
directory and file identity at operation boundaries. Final publication uses
exclusive hard-link creation, not replacing rename; manifest/receipt files use
exclusive no-follow creation. Descriptors and files are synchronized before a
success response.

This is not isolation from arbitrary malicious code running as the same Unix
user. Inputs and their filesystem must remain under trusted operator control.
No live production directory was moved or replaced during implementation.

Failure leaves new incomplete private files for operator inspection; the tool
does not recursively delete paths or retry into an existing destination. An
`incomplete.sqlite`, a missing completion manifest/receipt, or a failed command
is not a usable restore. Never point the app at those files. Inspect the failed
output separately and select a new unused path for a subsequent attempt.

Errors are fixed codes rather than SQLite details or file contents. CLI success
output includes selected output paths and status, not private database rows.

## Validation evidence

Synthetic fixtures exercise live committed WAL backup, manifests and private
modes, auth generation/session invalidation, exact product/native IDs/history,
calendar uncertainty, main-DB Edge journals, artifact lineage, normal boot's
submitting-to-unknown transition, operations missing after an older snapshot,
corrupt/hash/version failures, symlink/hard-link/overwrite refusal, interrupted
directory rename, excluded computer/config files and actual CLI invocation.

```sh
node --test test/product-backup.test.ts
node --check src/product-backup.ts
node --check scripts/product-backup.mjs
npm run typecheck
```

The external review that reported a destination-path race was stopped before
clearance. The implementation was corrected to pin directory descriptors and
ordinary correctness tests were rerun; it has **not received final independent
security-review clearance**. No real private database restore, disaster-recovery
drill, Runtime reconnect or complete-system consistency verification was run.
