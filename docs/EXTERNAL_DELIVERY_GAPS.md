# External delivery and private connector boundary

Source revision: `7e8f7d81f8b00fd45544d94d5b9a321214633df1`.
The current product implements an in-app inbox and a public-read host adapter.
It has no connected private account or external notification destination.

## Verified reuse

| Source | Existing capability | Boundary |
| --- | --- | --- |
| [application notifications](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/application/packages/application/src/notifications.ts#L9) | Authenticated notification projection, all/off settings, read receipts | Read/inbox status does not prove external delivery |
| [Session IO output](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/session_io/output.rs#L101) and [Session messaging](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/tool.rs#L795) | Committed typed Session output and messages between one Agent's Sessions | Does not send email, push or third-party chat |
| [Application collaboration](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/application/packages/application/src/collaboration.ts#L463) | Watches local Artifact version signatures and enqueues input | Not a provider webhook receiver |
| [Host tools](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/host_tools.rs#L40) | Protocol-1 native Job/Call/Principal/Session/Thread callback identity, default at-most-once retry safety | Product authorization and provider effects still need their own checks |
| [Model OAuth setup](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/web.rs#L2778) | Built-in model-account authorization adapters | Not a generic Gmail/Slack/GitHub OAuth registration API |
| [Secret Store](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/secret_store.rs#L37) | HTTP metadata and internal scoped Rust value resolution | Host callback clients cannot use an invented HTTP secret-value endpoint |

The product's `native-host-authority.ts`, shared callback listener and immutable
receipts can be reused by a future specific adapter. `ConnectorAdapter` currently
permits only `effect:'public_read'`. Private reads or messages must not be added
by relabeling that operation or reusing model-account grants. Runtime source
remains unchanged.

## Minimum configuration choices

Before implementing and exercising a specific private/external integration, choose:

1. Provider and account/workspace, exact permitted reads or send destination
2. Notification recipients, event categories and whether message contents may leave the product
3. Provider-specific credential custody, app registration and redirect setup
4. For incoming events, event types, supported verification and reachable authorized endpoint

A provider-specific implementation must retain stable effect intent/receipts,
current authorization and unresolved outcome handling. Native Job admission or a
local outbox record is not evidence the recipient received a message. Do not
retry an uncertain external mutation unless the provider supplies a safe key or
reconciliation mechanism.

Owner-controlled categories, quiet hours and frequency limits could improve the
existing in-app outbox without an account. Such policy would still not establish
external delivery or private-account access. No placeholder disabled adapter is
counted as either capability.
