# Implementation status

Updated 2026-09-30. Active development; no full-clone or production-ready claim.

| Area | Status | Evidence / remaining gate |
| --- | --- | --- |
| Source/Git | Active, pinned | Morphz 7e8f7d81; local incremental commits; no remote publication |
| Runtime binary/startup | Actual verified | Official v0.1.3 checksum/version; isolated auth IO startup |
| Persistent real BFF | L2 passed | Stable identity, typed admission/retry, actual file tool and committed output, restart |
| Native Objectives/concurrent chat | L2 passed, two conditions | Held-model test plus explicitly authorized NON-SANDBOX fixture: actual8s exec while foreground chat committed after238ms; actual final file/exit/Objective; no real-model quality claim. See LONG_TOOL_VALIDATION.md |
| Exact task supplement | Actual Runtime L2 passed, UI integrated/reviewed | Native Objective/generation destination, same-key receipt and stale-generation rejection; following task model input received text; no global interrupt. Bound question replies unavailable without exact question text |
| Real approvals | L2 denial passed | Out-of-workspace write requested approval, deny forwarded, no forbidden file |
| BYOK | Implemented, L1/security fixtures | Morphz provider/model/account/Secret Store reuse; masked status; no paid automatic probe; real provider setup not exercised with user key |
| Native reminders | Fixed intervals and daily/weekly calendar implemented; future-schedule L2 passed | Explicit IANA/DST/UTC preview, durable controls/unknown recovery, fair background reconciliation; actual Runtime future one-shots/UTC/restart/control passed; one actual UTC due reply recovered after BFF downtime; proposal-only model host + authenticated confirmation L2 passed; real model/channel quality remains unverified |
| Stream draft projection | L1 + L2 passed with compatibility path | Actual public prefix, BFF restart/no input replay, honest draft discard, one committed output; typed-IO upstream mismatch documented |
| Headed computer | Native Edge L2 + compiled helper, live display unverified | Narrow Edge protocol, native image import, exact action approvals, X11 helper, owned VNC lifecycle and opt-in CLI implemented; no live X11/VNC/deployment proof |
| Frontend | Functional integration; approved refinement integrated | Actual state/BYOK/approvals/reminders/memory/artifacts/inbox/noVNC; snapshot/retry/navigation fixes tested; pixel and real-device QA still pending |
| Frame memory | Agent-managed; read-only UI | Supported official recall/search only; factual corrections in conversation; manual editing is explicitly out of scope |
| Attachments/artifacts | Product upload + registered-resource L2 passed | Resumable bounded native stages, hash/native offset/restart, atomic exact chat command, immutable input/output download; UI recovery reviewed/tested; owner-only named documents/immutable lineage/parent CAS/receipt recovery and Files UI implemented/reviewed; actual native lineage L2 passed; arbitrary byte editing/external sharing incomplete |
| In-app notifications | L2 durability passed | Metadata-only inbox, acknowledgement/settings/restart; no external push |
| Voice | One-shot browser foundation implemented, L1 + independent review | 13 provider/service/HTTP tests; bounded capture, explicit transmission consent, reviewed transcript, committed-message TTS; real mic/provider and continuous calls unverified |
| External connectors | Public-read host and launcher committed and independently reviewed | Separate policy-bound native callback listener, owner-protected inventory, shutdown drain; actual Runtime callback L2 with synthetic public-data transport passed; live public GitHub GET timed out; no OAuth account connection or external delivery guarantee |
| Login/device sessions | Backend and session UI committed and independently reviewed | 11 HTTP/socket/action-admission regressions + 13 foundation tests passed; cookie-bound streams and post-await writes/grants recheck revocation; single-owner sessions; optional exact HTTPS entry requires auth; not multi-tenant |
| Remote/mobile transport | Explicit HTTPS origin integration committed and reviewed | Canonical Host/Origin/CSRF/WSS and Secure cookies; local BFF listener, mandatory owner auth for HTTPS entry, no forwarded-header authority or silent auth-database migration; proxy/TLS deployment and phone connectivity unverified |
| Native clients | Desktop client with explicit mic/save controls committed | Electron44.5.1 lockfile, isolated exact-origin renderer/login, native audio consent and exclusive bounded artifact saving; 25 focused fixtures and independent review passed; mobile Expo57/RN0.86 trusted-BFF wrapper:17 tests/TypeScript and clean-lock offline Android+iOS Hermes export passed; no APK/IPA or GUI/OS/device/install proof, push or continuous voice |
| Product backup/recovery | Experimental opt-in CLI;11 fixture tests passed | Main DB only, new-path restore and restored-device-session invalidation; companion control DB/Runtime/bytes excluded; final independent security review incomplete, no real recovery acceptance |
| Live model | Needs user configuration | BYOK password form, no keys in chat; explicit usage scope/budget before assistant-driven paid test |
| Release | Not authorized/configured | GitHub account/repo/visibility and target host remain decisions |

Latest checkpoint: [VALIDATION_CURRENT.md](VALIDATION_CURRENT.md). Details: RUNTIME_VALIDATION.md. Historical TEST_REPORT.md only describes the original mock baseline. L1 unit/protocol fixtures; L2 actual Runtime + deterministic local provider; L3 authorized real model/tool outcomes; L4 real external device/channel. Lower levels never substitute for higher ones.

Runtime source must remain unmodified. The unshipped memory-write experiment was withdrawn in a reversible commit; it is not a required feature or active build dependency.

Current constraints are recorded in README.md: unchanged Runtime source, no manual memory editor, native BYOK reuse, same-session visible computer goal, local Git/no ZIP/no publication, and full-access confined to explicitly selected disposable tests.

Visual direction: retain the first richer layout/color/density, polish details with Muse as a reference; the second minimal concept was not selected. User provisionally approved the latest first-layout refinement; integrated in972f029 with53 focused UI/audio tests passing. Live pixel QA remains pending.
