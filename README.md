# opendots

A personal assistant built on Morphz: persistent conversation, native background Objectives, real approvals, BYOK, and a visible computer with explicit human/AI control ownership.

This is active implementation, not a completed dots clone. [STATUS](docs/STATUS.md) separates implemented, fixture-tested, real-Runtime-tested, and missing capabilities. No simulation is silently substituted for a missing runtime.

## Run the application

Requirements: Node.js 24, a local Morphz 0.1.3 Runtime matching revision `7e8f7d81f8b00fd45544d94d5b9a321214633df1`.

```sh
npm ci
npm test
npm run check
MORPHZ_URL=http://127.0.0.1:18804 npm start
```

Open http://127.0.0.1:3210 . When Runtime authentication is enabled, configure `MORPHZ_OPERATOR_TOKEN` securely in the server environment. Never put it in a URL, frontend bundle, Git, or chat. This first implementation is a single-user local host; its operator adapter refuses remote Runtime origins. Do not expose it as a public multi-user service.

No configured Runtime? The UI explicitly shows configuration required. It does not generate fake answers. SQLite product data defaults to `.data/opendots.sqlite`; restart reuses the exact saved Agent/Context/Session binding. Use `OPENDOTS_DB_PATH` to choose another isolated product database. Never point different runtimes at one verified binding.

## Optional owner login

Set `OPENDOTS_AUTH_CONFIG` to an explicitly prepared private configuration file
as documented in [owner authentication](docs/AUTH.md). This enables per-device
cookies, CSRF checks, expiry and revocation for this single owner. Removing the
configuration after enabling it fails closed. The login page never adds public
network exposure; the server still binds to numeric loopback. Runtime service
credentials and owner login credentials have different purposes and are not
interchangeable.

For a remote single-owner entry, [HTTPS transport](docs/REMOTE_TRANSPORT.md)
documents the explicit `OPENDOTS_PUBLIC_ORIGIN` mode. It requires owner auth and
an independently configured trusted TLS proxy; the BFF still listens locally.
An existing authenticated database cannot silently change its bound origin.
No proxy deployment or real phone connectivity has been verified here.

## Native clients

The [desktop client](docs/DESKTOP_CLIENT.md) and [mobile client](apps/mobile/README.md)
connect to the real product. Mobile has a native connection/lifecycle shell and
loads the authenticated HTTPS interface. Android/iOS production JavaScript
bundles were exported; no APK/IPA, real phone or native desktop acceptance is
claimed. Mobile microphone/file transfer and continuous voice remain unavailable.

## Bring your own key

Use Settings in the application to create a provider connection using Morphz's existing provider/account/model-route and Secret Store APIs. Enter your API key yourself in the password field. The application forwards it transiently to the local Runtime and never saves it in its command/audit tables or returns it to the browser.

Saving a connection does not run a paid inference test. Explicitly bind the configured account to this assistant and choose its model. Model/provider readiness is distinct from merely connecting to the Runtime. Existing Morphz accounts can be selected without entering a new key. Provider credentials are managed by Morphz, not a second opendots secret store.

## Validation

```sh
npm test
npm run check
OPENDOTS_RUNTIME_BINARY=/absolute/path/to/morphz npm run test:runtime
```

The runtime test uses a real isolated Morphz process and a deterministic local synthetic provider, with no external paid model calls or user configuration. It checks actual file-tool execution, durable receipts and restart behavior. This is L2 evidence, not real-model quality validation. See the current status and test output for the exact coverage.

A historical simulation is available only with `npm run demo`; its UI/output must remain visibly labeled. It is not the application default.

## Live computer

[Live computer contract](docs/LIVE_COMPUTER.md) describes the required headed browser/desktop, live preview, takeover, and return within the same session. The epoch arbiter is implemented; the transport/deployment integration has its own acceptance gate. A noVNC frontend `viewOnly` flag is not a security boundary. Raw VNC/CDP must never be exposed publicly.

## Architecture and progress

- [Complete Chinese implementation plan](docs/IMPLEMENTATION_PLAN.zh-CN.md)
- [Roadmap](docs/ROADMAP.md) and [implementation status](docs/STATUS.md)
- [Daily/weekly calendar reminders](docs/CALENDAR_REMINDERS.md): explicit local time/DST policy, UTC preview and native schedule lifecycle
- [Conversational calendar proposals](docs/CALENDAR_PROPOSALS.md): model proposes, authenticated owner reviews/admits; independent host-tool configuration and durable retry
- [Document/version lineage](docs/ARTIFACT_VERSIONS.md): private product documents over verified immutable native resources
- [Experimental product backup/recovery](docs/BACKUP_RECOVERY.md): explicit main-DB scope and incomplete security-review gate
- [Source audit](docs/SOURCE_AUDIT.md)
- [Acceptance layers](docs/ACCEPTANCE.md) and [security](docs/SECURITY.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md) and [offline dependency inventory](docs/DEPENDENCIES.md)
- [Minimal desktop client](docs/DESKTOP_CLIENT.md): isolated Electron window for the separately running local server; graphical validation and installer packaging remain open
- [Connector integration](docs/CONNECTOR_INTEGRATION.md): fixed native host proof and credential-free public repository reads; private account connections are separate

Morphz owns cognitive state, Objective/Thread lifecycle, execution and approvals. opendots owns user-facing application state, durable input receipts, authorized product content and views. Session IO history cursors remain opaque. Unknown external effects are never blindly repeated.

## Source management

Work is managed in local Git with incremental commits. No remote repository has been created or published. GitHub account, repository and visibility remain separate publication decisions. No new source ZIPs are produced.

Original opendots code has not yet selected a public distribution license. Upstream and dependency licenses remain applicable; release license/SBOM review is still required.

## Runtime and memory boundary

Morphz Runtime source is not modified. Memory is managed by the existing Agent; users correct facts or preferences in conversation. The product has read-only Frame inspection, not a manual memory editor. No custom Runtime patch or memory-write endpoint is required or shipped.

### Optional speech

Voice is off by default. See [VOICE.md](docs/VOICE.md) for the explicit server-side enable/configuration and provider/data-flow disclosure. Text BYOK and speech configuration are separate. Recording stays local until the user explicitly confirms transcription; recognized text is reviewed before chat submission. Read-aloud references only a committed assistant message. This is bounded browser capture/transcription/playback, not a continuous voice call. No real speech-provider or microphone validation has been performed in this workspace.

### Current project constraints

- Use supported Morphz APIs and existing application/provider configuration; never modify Runtime source or its database directly
- Memory is agent-managed; the UI offers read/search and conversational correction, with no manual editor
- BYOK uses Morphz provider/account/model/Secret Store facilities
- The computer goal is a headed same-session live preview, human takeover and safe return; actual device validation and AI-return adapter remain unfinished
- Source is maintained as local incremental Git commits. No further ZIP delivery. GitHub destination/visibility is undecided and nothing has been pushed
- Full-access mode was authorized only for the isolated fixed-command concurrency fixture. It is an explicit test flag, not a product or deployment default

### Optional headed desktop execution

The narrow Edge worker, native X11 helper, exact action approval UI and owned human-control lifecycle are implemented. Explicit `OPENDOTS_COMPUTER_CONFIG` wiring is documented in [COMPUTER_CONFIG.md](docs/COMPUTER_CONFIG.md); it consumes an existing dedicated Morphz node credential, never automatically pairs a device. Native image/approval transport passed against a real unchanged Runtime using a clearly synthetic display; the helper compiled. Live desktop/input/return and deployment isolation have **not** been accepted in this environment.
