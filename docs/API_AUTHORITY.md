# API authority and integration boundary

Baseline: Morphz `7e8f7d81f8b00fd45544d94d5b9a321214633df1`. The product uses existing APIs only. Source locations: `src/web.rs`, `src/sdk.rs`, `src/session_io/`, application modules identified in SOURCE_AUDIT.md. Runtime source/binary is unmodified.

| Operation | Current trusted caller | Browser scope / protection |
| --- | --- | --- |
| Agent bootstrap and provider/account settings | Local operator adapter | Fixed persisted Agent; allowlisted UI fields, no operator token returned |
| Context overview/scheduler | Local operator adapter; these are not generic principal-gateway reads | Fixed saved Context/Session; bounded terminal inventory, stale/truncated projection visible |
| Frame recall/search | Local operator adapter | Fixed Context; read-only; no manual memory mutation route |
| Typed Session IO/admission/history/resources | Native supported Session authority via local adapter | Fixed verified Session/Principal; opaque cursors, immutable event/resource provenance |
| Native Objectives, controls and approvals | Native Runtime authority | Fixed scope, revision-bound operations and durable command keys; acceptance is not completion |
| Native schedules | Native Runtime authority | Fixed Session; timezone intent is product-owned, fixed-second recurrence is native |
| Application WebSocket text observation | Server-only source-pinned compatibility adapter | Fixed Session; headers hold token; only public output text projected, no reasoning or raw operator feed |
| Speech transcription/playback | Product adapter using existing application speech protocol | Explicit per-request consent; fixed verified Principal; TTS only committed local Session output; no credentials/browser provider URLs |
| Computer preview/human input | Product control gateway | One-use protocol tickets and server-side epoch/lease checks; separate server-enforced read-only preview; AI return currently unavailable |

`MorphzOperatorAdapter` deliberately restricts operator use to loopback Runtime origins. A separate principal-header adapter contract does not make operator-only context/provider routes safe for remote multiuser exposure. The current product is a dedicated single-user local host; model-default selection can affect other sessions in the same Runtime and is disclosed in UI. Product optimistic guards are not native cross-client CAS.

Browser bodies cannot select a principal, Session, Context, executor URL, filesystem path, or arbitrary resource URL. The BFF does not mint user privileges based on chat content. New multiuser/remote deployment needs an authenticated product domain and an upstream supported scoped API design; broadening operator access is not an acceptable shortcut.
