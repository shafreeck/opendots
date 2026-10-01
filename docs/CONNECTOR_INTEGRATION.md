# Connector integration

## Implemented boundary

This implementation adds a real, credential-free GitHub public-data adapter and a
Morphz native host-tool bridge. It does not claim a connected GitHub account.
The operator explicitly supplies an allowlist of public repositories. The adapter
supports `get_repo`, `list_issues`, and `get_issue` only. No request can choose an
arbitrary URL, headers, credentials, query string, executable, or write operation.

Modules:

- `src/connector-types.ts`: strict typed callback envelopes, bounded JSON/HTTP
- `src/connector-runtime.ts`: fixed native capability catalogue and live native
  invocation verification
- `src/connector-github-public.ts`: working GitHub public REST implementation
- `src/connector-host.ts`: authenticated callback, required live product policy,
  durable at-most-once IO receipts, host manifest-entry builder
- `src/connector-config.ts`: strict read of one existing private operator config
- `src/connector-service.ts`: opt-in launcher composition and dedicated callback
  listener, including abort-and-drain shutdown

These modules do not start a listener, register credentials, modify a running
Runtime, or install an app on import. `ConfiguredConnectors.start()` explicitly
verifies the saved native identity before opening its dedicated callback.
Existing model-provider/BYOK settings stay separate.

## Existing private launcher configuration

The canonical flag is now `OPENDOTS_HOST_TOOLS_CONFIG`; the legacy
`OPENDOTS_CONNECTOR_CONFIG` remains compatible with this unchanged version-1
file. Set only one. [Version 2](CALENDAR_PROPOSALS.md) supports independent
public GitHub and owner-reviewed calendar proposal entries on one listener.

Set `OPENDOTS_CONNECTOR_CONFIG` to the absolute existing private config path when
launching `node src/server.ts`. `createApplication({connectorConfigPath})` provides
the same explicit option for embedding. Omission keeps connectors disabled.
Demo mode rejects this option. The callback starts only after the main BFF's
authentication readiness checks; a Runtime/callback startup failure is exposed
as connector `unavailable` and does not silently provision an alternative service.
Ordinary chat remains available. Main application shutdown awaits connector
abort/drain before closing the shared RuntimeStore database.

The strict configuration file contains exactly these fields. Placeholder values
are intentionally not a usable credential or native binding:

```json
{
  "version": 1,
  "ownerId": "<existing saved product owner ID>",
  "runtimeOrigin": "http://127.0.0.1:8080",
  "binding": {
    "principalId": "<existing native Principal ID>",
    "agentId": "<existing saved Agent ID>",
    "contextId": "<existing saved Context ID>",
    "sessionId": "<existing saved Session ID>"
  },
  "callbackPort": 3211,
  "callbackToken": "<existing separately provisioned private host token>",
  "allowPublicGithubReads": true,
  "repositories": ["morphz-ai/morphz"]
}
```

The absolute selected file must be a regular, single-link, current-UID-owned
private `0400` or `0600` file, at most 16 KiB, with trusted parents. Symlinks,
public modes, path indirection and changed descriptors fail closed. The loader
does not scan HOME/env files, discover secrets, change permissions, generate
tokens, pair devices, or write a manifest. Repositories must be a sorted,
deduplicated lowercase allowlist. Ports are fixed integers 1024–65535; the
callback listens only on `127.0.0.1`. The Runtime origin must exactly match the
already saved local product binding, whose verified flag must already be true.
Configuring connectors against an empty/unverified product database cannot
implicitly bootstrap another identity.

Keep this private config in an operator-controlled directory excluded from Agent
file access, for example the already protected parent of the existing native host
manifest. UID/mode checks protect against other OS users; they do not create a
new sandbox against a same-UID Agent. This launcher does not alter or claim to
verify Runtime protected-path configuration. Do not put the callback token/config
in an Agent-readable workspace or an exposed application artifact.

The existing Runtime host manifest must independently contain the connector
registration for `http://127.0.0.1:<callbackPort>/api/host-tools/connectors/call`
and that same existing callback token and exact Context. The launcher never
creates or alters this manifest. Its callback token must be separate from the
Runtime operator token and browser-owner login/session credentials. It is never
returned by catalogue/status responses or accepted through browser setup forms.

The configuration's explicit public-read policy authorizes only those public
repositories for the saved single owner. The service reopens and validates that
exact file before and after native invocation proof, as well as on receipt
replays. Changed, removed, invalid, disabled, or re-bound configuration prevents
new dispatch and receipt disclosure. Configuration changes require a deliberate
restart; they never silently rotate the live callback token. Browser logout
revokes that browser session; it does not relabel the server's separately
configured native callback as a browser session. To withdraw the public-read
policy, disable/remove the selected config and stop/restart its host.

`ConfiguredConnectors` requires the existing product store, fixed Runtime origin
and operator transport. Its startup performs only the two supported native
Session/Principal GETs, not a GitHub request. `catalogue()` is config-only;
`nativeCatalogue()` is an explicit native capability refresh. `ready` means its
private callback is listening after native identity checks. It does not mean the
tool was loaded by Runtime or GitHub was reached. Native registration starts
`unverified` and changes only after an explicit native catalogue read.

The dedicated callback accepts only POST on its exact path, exact numeric Host,
loopback peer, its private bearer, JSON no larger than 64 KiB, and strict native
envelopes. Browser Origin, Cookie, fetch-site and product-CSRF headers are rejected;
this is not a browser-auth bypass on the main listener. It has no GET catalogue,
generic proxy, setup, write or credential endpoint. Request-body reads expire at
5 seconds, overall callbacks at 15 seconds. Shutdown closes admission immediately,
aborts outstanding work, waits for admitted handlers to settle their durable
receipts, and closes the listener before the product database may close.

The main BFF exposes two read-only settings APIs within its normal private-route
owner-session gate:

- `GET /api/connectors`: configuration/status and the adapter catalogue. It makes
  no native or GitHub request. Enabled responses have service status plus
  `catalogue.connectors[]`; disabled responses have `status:'disabled'` and an
  empty `connectors` array. Credentials and callback origin/port are omitted.
- `GET /api/connectors/native`: explicit native capability refresh, only when
  configured. It returns the declared-target catalogue and updates the service's
  `nativeRegistration` evidence. A pending response is suppressed if its owner
  browser session is revoked before completion. It performs no GitHub probe.

The native callback path on the **main** BFF has no exemption: a host bearer is
not an owner cookie. The dedicated callback rejects owner cookies and browser
headers even when a valid native bearer is also present. Reusing the configured
owner login token hash or Runtime operator token as the native callback token
is rejected. Default unconfigured development retains the application's existing
trusted-loopback access model; enabling owner authentication applies to both new
settings routes exactly as it does to other private product routes.

## Source-pinned Morphz capabilities

Inspected revision: `7e8f7d81f8b00fd45544d94d5b9a321214633df1`, recorded in
`morphz-source.lock.json`. No Runtime modifications are required.

### Tools and catalogue

- CLI startup reads the host-owned absolute `MORPHZ_HOST_TOOLS_FILE`. It loads
  protocol-1 extensions and protects their manifest/parent from Agent file access.
  Tools are registered before the default execution target is materialized.
  There is no hot-reload promise. See [main.rs](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/main.rs#L250-L269).
- A manifest contains `protocol:1`, `tools`, and optional `formats`. Each tool
  has `definition:{name,description,parameters}`, a private `token`, exact
  `context_ids` and/or bounded `context_id_prefixes`, one numeric-loopback HTTP
  `endpoint` or private Unix `ipc_path`, and optional `idempotent_requests`.
  Host names start with `host_`; at most 16 tools, 256 KiB manifest, private regular
  file. Runtime limits calls to 20 seconds and responses to 2 MiB. See
  [host_tools.rs](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/host_tools.rs).
- Native callback POST body is exactly `{protocol:1,tool,arguments,invocation}`.
  Invocation has `job_id`, `tool_call_id`, `session_id`, `context_id`,
  `principal_id`, `agent_id`, `thread_id`, `target_id`. Runtime supplies these
  from the active durable ExecutionJob; model arguments cannot select identity.
  HTTP authenticates with the manifest bearer token. IPC has a separate
  length-prefixed authenticated envelope. This module implements the HTTP bridge.
- Default host retry safety is `AtMostOnce`. This connector manifest entry leaves
  `idempotent_requests:[]`, including for discovery. Do not advertise generic
  external writes as idempotent merely because a product receipt table exists.
- Rust embedding APIs include `RuntimeBuilder.extra_tool(Arc<dyn Tool>)`,
  `Registry.register`, `Registry.definitions`, `MorphzRuntime.tool_names`, and
  `physical_tool_names`. They are not HTTP APIs.
- `GET /api/execution-targets` returns principal-visible target records and their
  declared capability names. It is not an all-tool schema catalogue and does not
  prove a provider connection. `ConnectorRuntimeClient.catalogue()` projects only
  target ID/revision/kind/status/capabilities, explicitly labels the evidence, and
  drops workspace paths, metadata, and owner details. See [web routes](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/web.rs#L1182-L1189)
  and [target records](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/memory/mod.rs#L2357-L2375).
- No general MCP client, `mcp_servers` configuration, HTTP MCP registration, or
  generic `/tools/call` API was found in this pinned Runtime/application source.
  Claude provider MCP-shaped wire names are not a general connector subsystem.

### Concrete callback authority

The implemented resolver uses supported GET endpoints, not a host assertion:

1. `/api/execution-jobs/:job_id`: native Job, tool/call identity, frozen request,
   exact Principal/Agent/Context/Session/Thread/Target, status and cancellation
2. `/api/contexts/:context_id/threads/:thread_id`: `snapshot.thread`, identity,
   target, lifecycle and control state; this endpoint is **operator-only**
3. `/api/sessions/:session_id` and `/principal`: current Session identity and
   actual operator-resolved Principal

See [Job endpoint](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/web.rs#L5555-L5577),
[Job principal visibility](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/sdk.rs#L3980-L3998),
[Thread endpoint](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/web.rs#L5914-L5930),
and [Session Principal](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/web.rs#L7999-L8030).

Only a fixed loopback LocalOperator configuration is implemented. There is no
gateway-token fallback or model/browser-selected identity. A new call requires
the exact running, uncancelled Job and open, active Thread on `target-default`.
Native request comparison removes only four source-observed Runtime additions:
`_morphz_execution_route`, `_morphz_action_group_id`, `_morphz_wake_thread`,
`_morphz_capability_lease_objective_id`. The route must be local and match the
target. Remaining request JSON must equal the callback arguments exactly.
The normal physical-tool dispatcher removes the model-visible `target` before
constructing these arguments. Unknown extra metadata is rejected, not ignored.

Native provenance is not user permission. `ConnectorHost` requires a server-owned
`authorize(envelope,signal)` callback before and after native verification, and
again on every receipt replay. It must revalidate the persisted product identity,
current user authorization and repository policy. No default allow callback is
provided. The current adapter can only read public data. General write effects or
private accounts need a separate approval/credential design before exposure.
Separate HTTP reads cannot form an atomic cancellation barrier with Runtime;
dispatch uses the latest verified native state and product policy, and is bounded
and abortable. This is not a transactional fence over remote website effects.

The upstream application follows the same distinction: authenticated envelopes,
persisted Session identity, actual native thread/root-to-input provenance, then
live domain permissions. It never trusts selected UI scope or model-supplied
ownership. See [application AgentTools](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/application/packages/application/src/agent-tools.ts#L427-L442)
and [RuntimeBridge.toolScope](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/application/packages/application/src/runtime.ts#L627-L796).

### Credentials and OAuth: supported, but not generic connectors

- Operator SecretStore HTTP: `GET/POST /api/runtime/secrets`,
  `POST /api/runtime/secrets/import`, `GET /api/runtime/secrets/scope-options`,
  `DELETE /api/runtime/secrets/:name`. Listing returns metadata, backend status,
  import candidates and recent-use audit. It never resolves a secret value.
- Managed values stay behind Rust `SecretValueBackend` implementations.
  `SecretStore.resolve(name,SecretUseContext)` is an in-process Rust API with
  scope/audit checks, not a Node/BFF HTTP credential-read API. Native
  `list_secrets` exposes aliases only; `exec.requested_permissions.secret_env`
  injects approved values into a specific child. This is not an appropriate
  workaround for host-connector credentials. The host callback does not inject
  SecretStore values. See [SecretStore](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/secret_store.rs#L30-L103)
  and [scope-aware resolver](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/secret_store.rs#L855-L892).
- `GET /api/runtime/providers` is a model-provider control snapshot. It may prune
  unfinished OAuth setup before returning, so it is not used by this connector
  inventory. Existing BYOK settings already cover this distinct product area.
- Supported model OAuth discovery is `GET /api/runtime/providers/oauth/services`.
  This source has dashboard setup services `codex`, `kimi`, `anthropic`,
  `antigravity`, `xai`, filtered against built-in adapters actually registered.
  General Rust `AuthAdapterRegistry.register` is an embedding API, not external
  provider app registration over HTTP.
- Model OAuth flows: `POST /api/runtime/providers/oauth/start {service}`;
  account-specific `POST /accounts/:id/oauth/start[/adapter_id]`;
  `POST /oauth/:login_id/continue` with `authorization_code`,
  `authorization_response`, or `poll`; `DELETE` that continuation route to cancel;
  `GET/POST /oauth/callback`; account `POST /oauth/logout`. Prefixes are under
  `/api/runtime/providers`. Runtime owns PKCE/state, bounded login lifetime,
  callback routing, token persistence, and fenced refresh. Browser/runtime
  callback placement and provider app registration must match the adapter.
  See [routes](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/web.rs#L1014-L1126),
  [OAuth contract](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/provider/auth.rs#L600-L689),
  and [materialization/refresh](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/provider/auth.rs#L1385-L1410).

These model grants must not be relabelled as GitHub/Gmail/Slack account access.
This implementation adds no OAuth flow, credential reader, refresh daemon, fake
connected account, or dependency on dot's private connectors. Future private
connectors require user setup of the correct provider app/scopes and a proper
server-side credential authority; that is an explicit remaining feature.

## GitHub public contract

Fixed API origin `https://api.github.com`, API version `2026-03-10`, GET only,
`credentials:'omit'`, `redirect:'error'`, no Authorization or Cookie header.
Every operation first verifies that the exact allowlisted repository is public;
renames/redirects, identity changes, private flags and malformed results fail
closed. Reads use at most two HTTP requests, one shared 5-second deadline,
1 MiB per response, and no automatic retry.

- `get_repo({repository})`: bounded repository metadata
- `list_issues({repository,state?,page?,perPage?})`: state open/closed/all, page
  1–100, perPage 1–20, fixed updated-descending ordering, one page only
- `get_issue({repository,number})`: positive 32-bit issue number

GitHub's issue endpoints also return pull requests. Results explicitly preserve
that distinction; list bodies truncate at 2,000 characters, single bodies at
24,000 with `bodyTruncated`. `mayHaveMore` is a conservative full-page hint, not
a promised next page. Results are tagged `untrusted_external_data`; body text is
never instructions or authority. Account emails, provider tokens, arbitrary
metadata and response headers are not projected. `status()` returns configured
public-data access and the last successful read time, without a network probe or
account-connected claim.

Official documentation confirms unauthenticated access for public resources:
[get repository](https://docs.github.com/en/rest/repos/repos#get-a-repository),
[list repository issues](https://docs.github.com/en/rest/issues/issues#list-repository-issues),
[get issue](https://docs.github.com/en/rest/issues/issues#get-an-issue),
[API versioning](https://docs.github.com/en/rest/about-the-rest-api/api-versions).

## Host composition contract

1. Use the verified persisted product binding, existing Runtime origin/operator
   authority, and existing SQLite product database. Never accept these from an
   incoming model/browser request.
2. Construct `ConnectorRuntimeClient`, `GitHubPublicConnector` with explicitly
   allowed repository names, and `ConnectorHost`. Supply a real product
   `authorize` callback; do not use a no-op in production.
3. Bind a private loopback HTTP callback. Before `host.handle(authorization,body,
   signal)`, enforce POST, exact path, 64 KiB body limit and bounded request time.
   Never forward the browser's product-auth token as the Runtime callback token.
   Renderer routes, if exposed, need ordinary product user auth/CSRF controls;
   they must not forge native callback envelopes to run tools.
4. `connectorHostRegistration({contextId,endpoint,token})` returns **one entry**.
   Merge it into the existing private protocol-1 manifest without removing the
   computer tool or other registrations. Operator provisioning supplies the
   callback token securely; this builder does not create/store credentials.
   Restarting an isolated or user-approved Runtime is required to load changes.
5. `host.catalogue()` describes registered product operations and explicitly
   does not claim they are loaded in Runtime. `runtime.catalogue()` separately
   proves the currently advertised native capability name. There is no invented
   all-native-tool schema inventory.
6. `host.handle` returns `{id,jobId,toolCallId,status,replayed,result,errorCode}`.
   This is a host IO receipt; actual native Job completion is still Runtime-owned.
   A startup-loaded connector executes on `target-default`. A Thread already
   bound to the desktop target cannot silently move there; use the Runtime's
   supported new-thread routing when both kinds of tools are needed.
7. On shutdown call `host.close()`, stop the callback listener, and await admitted
   handlers before closing the product DB. Disconnecting a client or exceeding
   the 15-second host deadline aborts future IO and leaves an unknown receipt.

Receipt identity is a SHA-256 digest of the fixed product binding plus native
Job/call IDs. A separate canonical payload hash detects changed arguments.
SQLite inserts `dispatching` before external IO. Success stores a bounded result;
failure/interruption becomes `unknown`. Reopened `dispatching` rows also return
unknown and never redispatch. Concurrent duplicates cannot create a second call.
Successful retries after native completion return the same receipt after current
identity/permission checks. No raw arguments, exception messages, credentials,
URL-bearing errors or response bodies are logged by this module. Persisted
public results remain sensitive application data in aggregate and follow normal
product retention/access rules. Native Runtime history still retains its own
original tool arguments and result according to Runtime policy.

## Verification on 2026-09-30

- Full default application suite passed after launcher integration: 308 passed,
  2 intentional opt-in integrations skipped, 0 failed (`npm test`). This includes
  38 connector fixture tests across validation, native proof, receipts, private
  configuration, dedicated HTTP callbacks, and authenticated BFF integration.
- Final aggregate strict TypeScript, changed-file Node syntax and diff checks
  passed. The earlier parallel server edit/typecheck issue was resolved before
  this final aggregate run.
- L2 explicitly passed with the unchanged official Morphz v0.1.3 binary, SHA-256
  `29a5c5cb04cdc407858db04b49c5f52fd18892c831aad395e01cc3e4f172b8d3`:
  startup capability registration, real host callback, supported live native
  Job/Thread/Session/Principal proof, next-model result delivery, native Job
  `succeeded`, committed final reply, and same-ID replay after completion without
  a second adapter request. One adapter request, two local deterministic model
  calls, zero paid calls. GitHub transport in this test was synthetic.
- Run L2 explicitly:
  `OPENDOTS_RUNTIME_BINARY=/path/to/verified/morphz node --test test/connector-native.test.ts`
  It uses disposable directories/config/data, local deterministic provider,
  request-approval mode, no desktop, and cleans up the child process/listeners.
- The real anonymous `get_repo` attempt for `morphz-ai/morphz` did **not** complete:
  fixed 5-second deadline, `connector_request_aborted` / 503, no upstream HTTP
  response observed. No alternate network route, security change or automatic
  retry was attempted. Live GitHub operation is therefore **unverified on this
  host**, not a claimed success. On a permitted reachable deployment host run:
  `OPENDOTS_CONNECTOR_LIVE=1 node --test --test-name-pattern='live anonymous' test/connector-github-public.test.ts`

Fixture coverage includes strict schema/repo/enums/number bounds, no auth headers,
public identity checks, pull-request classification, pagination/truncation,
redirect/403/oversize handling, error privacy, aborted sends, exact native
arguments/identity, inactive/cancelled/paused execution rejection, terminal replay,
mandatory authorization/revocation, concurrent receipt deduplication, restart
recovery, shutdown and late-completion uncertainty. HTTP integration additionally
covers private file validation, saved-binding enforcement, separate native and
browser authority, configuration revocation during native proof, owner-session
revocation during an async catalogue read, port conflicts, and database-safe
abort/drain of an admitted callback during application shutdown.
