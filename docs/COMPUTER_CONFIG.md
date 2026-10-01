# Explicit computer configuration

`src/computer-config.ts` supplies a two-stage, operator-only loader for the
existing Morphz Edge credential format. Importing the module does nothing. Loading
configuration does not pair a node, generate a key, connect to Runtime, start a
desktop/VNC process, read Xauthority, or change permissions. There is no HTTP
configuration endpoint or HOME/environment credential discovery.

This module is Linux-only. It prepares configuration and a restricted signer; it
does not establish that a live desktop, isolation boundary, or human-input fence
has passed acceptance testing. See [Computer Edge](COMPUTER_EDGE.md) and
[Linux desktop driver](LINUX_DESKTOP_DRIVER.md).

## Integration contract

1. An explicit opt-in launcher receives one absolute public configuration path.
   Call `readComputerConfig(configPath)` to get a frozen `ComputerConfig` snapshot.
   This first stage reads no credential file, even when that file does not exist.
2. Start the normal BFF and verify its saved fixed Principal/Agent/Context/Session
   through Runtime. Do not invent a new identity or read its store a second time.
3. In trusted host preparation, call:

   ```ts
   const loaded = loadComputerConfig({
     configPath,
     expectedConfig: initialConfig,
     runtimeOrigin: configuredLocalOperatorOrigin,
     identity: { principalId, agentId, contextId, sessionId },
   });
   ```

   The loader rereads and compares the entire normalized public snapshot before
   reading credentials. A changed snapshot fails closed. The returned `binding`
   takes its node/target/policy from that snapshot and its four user/session IDs
   exclusively from the verified BFF identity. Compare it with the host's current
   binding before connecting the driver or transport.
4. Use `loaded.runtimeOrigin`, `loaded.binding`, the configured `workerId`, and
   `loaded.signConnectionProof` with `ComputerEdgeClient`. Keep the ordinary
   product exact-action authorizer, journal, arbiter, and driver checks enabled.
5. Shutdown calls `loaded.close()`, which disables further signatures. It does not
   alter or delete the native credential. Do not serialize the loaded object into
   an API response, diagnostics, telemetry, or a browser state payload.

The public config must have exactly these fields; unknown or missing fields fail:

| Field | Accepted value / responsibility |
| --- | --- |
| `version` | `1` |
| `dedicatedNode` | `true`; operator attestation described below |
| `credentialsPath` | Explicit, absolute native credential JSON path |
| `nodeId` | Exact existing dedicated Edge node ID |
| `targetId` | Fixed reviewed desktop target, never `target-default` |
| `policyDigest` | Fixed reviewed execution-route policy digest |
| `workerId` | Fixed worker identity |
| `display` | Local X display, such as `:99`; no host name |
| `xauthority` | Fixed absolute driver-approved path; contents are never loaded here |
| `browserPid` | Integer process ID greater than 1; checked by the launcher/supervisor |
| `browserInstanceId` | 8–128 ASCII letters/digits/underscore/hyphen; changes on browser replacement |
| `previewPort` | 1024–65535; local private preview service |
| `previewReadOnlyEnforced` | `true`; operator attestation described below |
| `controlPort` | 1024–65535, different from preview; owned private input service |
| `reviewedX11vncSha256` | Exact 64-character lowercase SHA-256 of the operator-reviewed x11vnc 0.9.16 build |

Do not substitute an example hash for a reviewed executable. The lifecycle module
performs its own executable hash/version verification. A config hash, PID, and
instance label alone do not prove executable provenance or a current browser.
The supervisor must pin process incarnation, revoke control on death/replacement,
and verify the same display/browser before every relevant operation.

### Required deployment attestations

`dedicatedNode: true` means this existing native credential is reserved for the
narrow OpenDots desktop worker. Its advertised capability is only
`host_opendots_computer`. Do not concurrently use `morphz-edge`'s general physical
tool runner, an unrestricted execution target, or another worker with the same
credential. The loader cannot independently prove this without network/setup
actions; it does not make those actions or claim that proof.

`previewReadOnlyEnforced: true` means the preview server has been independently
configured and reviewed to enforce read-only operation **and no clipboard changes
server-side**, on exactly the configured `DISPLAY`. A browser-side noVNC flag is
insufficient. Preview and control ports must refer to separate input policies on
the same display, not separate desktops. The flag is an operator declaration,
not a live protocol or process verification.

The Runtime must not be able to reach the desktop's X socket, VNC/CDP ports or
filesystem through built-in execution tools. Keep its network and filesystem
namespace separate. The BFF's existing loopback-only operator restriction remains
unchanged. If separate containers require connectivity, deployment must provide
an explicitly trusted narrow connector/proxy whose BFF-side origin is loopback.
This loader neither constructs that proxy nor accepts a remote operator URL.

## Existing native credential, not a new secret store

The source contract is the unchanged pinned Morphz commit
`7e8f7d81f8b00fd45544d94d5b9a321214633df1`:

- `morphz/src/edge_node.rs:250–271`: Ed25519 identity generation and
  `EdgeNodeCredentials` fields
- `edge_node.rs:297–316`: native save uses mode `0600` on Unix
- `edge_node.rs:915–929`: parse the stored PKCS#8 key, compare its public key and
  sign the native node connection proof
- `Cargo.lock`: ring `0.17.14`; its Ed25519 parser accepts PKCS#8 v2 containing
  the public key, including the documented legacy public-key tag

The exact [ring 0.17.14 source package](https://static.crates.io/crates/ring/ring-0.17.14.crate)
was read without installation or execution and checked against the lockfile SHA-256
`a4689e6c2294d81e88dc6261c768b63bc4fcdb852be6d1352498b114f61383b7`.
Its `ed25519_pkcs8_v2_template.der` and `from_pkcs8` parser were inspected directly.

The credential JSON must contain exactly:

```text
server_url
node_id
device_key_fingerprint
device_public_key
device_private_key_pkcs8
```

The public and PKCS#8 fields use native lowercase hexadecimal. The fingerprint
must equal `sha256:` followed by SHA-256 of the raw 32-byte Ed25519 public key.
The loader accepts the canonical native v2 layouts, including ring's legacy tag.
It rejects v1-only private keys, arbitrary ASN.1 variants/attributes, other
algorithms, trailing bytes, and partial values. It independently derives the
public key from the seed and checks both the embedded and declared public keys.
No trust is placed in an embedded public key merely because Node can parse it.

`server_url` and the BFF-configured `runtimeOrigin` must normalize to the exact
same loopback HTTP(S) origin. Host aliases, schemes and different ports do not
match. Userinfo, path prefixes, query strings, fragments and non-loopback hosts
are rejected. A local proxy must already be the explicitly configured origin in
both places; the loader does not rewrite credentials or auto-retarget a node.

The returned signer only signs bounded native `morphz-edge-connect-v1` proofs for
this exact node. It is not a general signing API. It does not send a signature or
private key anywhere; the separate Edge client performs the authorized protocol.

## File and privacy checks

- Both JSON files must be regular, single-link files of 1–16384 bytes
- Credential file owner must equal the process's effective UID; mode `0400` or
  `0600` is accepted. No group/world access, execute, or special bits are allowed
- Public config owner must be the effective UID or root, readable and without
  group/world write, execute, or special bits; `0600` or `0644` are typical
- Symlink files and symlink path ancestors are rejected. Ancestors must be owned
  by this user or root and not group/world writable, except root-owned sticky
  temporary directories leading to a private owned subdirectory
- The actual descriptor is opened with no-follow/nonblocking flags, then its
  owner/mode/type/inode are checked **before any content read**. Metadata/path
  checks are repeated after the bounded read to detect ordinary replacement races
- Same-user/root compromise remains outside this boundary. These checks do not
  create an immutable filesystem, defend against a malicious kernel, or replace
  OS sandboxing and administrator control
- Failures expose only product error codes. Native filesystem/JSON/crypto messages,
  private bytes and file paths are not returned as error details or logged
- The only retained private material is the in-process signing key. Temporary
  byte buffers are cleared where possible; JavaScript strings, garbage collection,
  native key memory, crash dumps and filesystem backups prevent any guarantee of
  forensic erasure. Use an appropriate service account and existing OS protection

No setup has been performed by this module. An operator must already have an
authorized, separately paired dedicated native node and reviewed deployment. Do
not paste a credential or its contents into chat, browser forms, logs, fixtures,
or Git. Any new pairing/access provisioning is a separate explicit setup action.

## Evidence

`node --test test/computer-config.test.ts` uses only newly generated, unpaired,
temporary test credentials and synthetic metadata. It verifies both native key
encodings and signatures, no credential read in stage one, immutable snapshot
comparison, fixed origin/node identity, public/private/fingerprint consistency,
safe errors, permission checks before reading, symlink/hardlink rejection, input
bounds, and closed-signer behavior. No real credential, X authority, browser,
network connection or desktop input is used by these tests.

## Executable application entry

The ordinary server now accepts one explicit opt-in:

```sh
OPENDOTS_COMPUTER_CONFIG=/private/path/computer.json \
MORPHZ_URL=http://127.0.0.1:3000 npm start
```

No option means no Edge worker, no credential read and no physical driver. The
normal chat application remains usable without a computer. In opt-in mode the
BFF first verifies its saved Runtime identity, then loads the existing node signer,
verifies the exact browser process lifetime and reviewed input-server binary, and
connects the native driver. Each physical action waits for a separate one-time
approval showing the exact retained observation and action. Approval is not a
claim that a website transaction succeeded. Credential/payment entry should be
completed by the user through human takeover.

`src/linux-computer.ts` wires the real driver and owned human input-server
lifecycle. The human path can initialize locally while Runtime/Edge authentication
is unavailable; AI return additionally requires a connected worker. A fresh human
lease uses an owned input server. Return revokes transport, checks clean shutdown,
checks held input and captures the same display. An explicitly acknowledged repair
may clear only the driver input latch; historical uncertain effects remain recorded.

The provided container entrypoint can read this same explicit config. It creates
a private temporary NONSECRET copy containing its own supervised browser PID and
fresh browser instance identity, without modifying the operator file or credential.
In this mode the Node host owns the control VNC process; the entrypoint starts only
the independent server-enforced read-only preview. The manifest and native node
must already be provisioned using Morphz's supported operator flow. This application
does not silently pair a device, install a manifest or grant persistent access.

The deployment image now builds the C helper in a separate build stage. Docker
build/run and real graphical operation have not been validated here. Private
Runtime connectivity, preview identity/read-only enforcement, namespace isolation,
input fidelity and actual handoff acceptance must be checked on the chosen host.
