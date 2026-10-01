# Remaining work and decision boundaries

This is an active implementation, not a complete dots/Muse clone. STATUS.md and ACCEPTANCE.md distinguish implemented code from live proof.

## Engineering work still available without real credentials

- Exercise opt-in owner authentication with real browser/device sessions; HTTP/WS/UI integration and device-session controls are implemented and regression-tested
- Validate the reviewed desktop microphone/save-dialog interactions on real devices; produce installer/signing and graphical acceptance evidence
- Real public connector transport acceptance; readonly inventory UI and native invocation/launcher integration are implemented. Private-account OAuth remains separate
- Daily/weekly recurrence, one real due-time recovery and the proposal-only model host are implemented/validated at their documented levels. Real-model reminder behavior and external delivery remain open; monthly/cron is outside this bounded version
- Owner-only named documents/version lineage are implemented and actual native-resource wiring passed; arbitrary content editing and authorized external sharing remain separate
- Product-only backup/restore CLI is experimental with11 passing fixture tests; final independent security review and real coordinated recovery/migration/long-running exercises remain. Dependency/license/SBOM work remains; mobile Expo dependency tree has one known uuid advisory propagated to19 moderate affected package entries (see DEPENDENCIES.md)
- Canonical HTTPS origin mode is implemented/reviewed; actual TLS proxy deployment and phone connectivity remain unverified. Mobile source, lifecycle tests and Android/iOS JavaScript bundles are implemented; native build/signing, real-device acceptance, external push/channel delivery and continuous voice remain incomplete
- Live visual QA of the provisionally approved, integrated rich warm/forest refinement; no further redesign requested

## Verified environment limitations

- Docker deployment and actual headed X11/VNC/browser input have not been run here
- Browser pixel inspection has not been established in this task environment; design images are concept previews, not evidence of live product behavior
- Native helper compilation succeeded using a private official-header sysroot, but that does not prove graphical behavior

These limitations stop only the relevant live validation; they do not justify calling unfinished product modules complete or stopping independent engineering work.

## User/operator configuration and release decisions

- Real model/provider configuration must be entered through a secure user-managed path, never pasted into chat; assistant-driven paid validation needs a bounded authorized use
- Existing dedicated Edge node, reviewed input-server build and explicit private desktop/Runtime topology are needed for real computer acceptance; no automatic persistent pairing or privilege expansion
- External account OAuth/client registration and delivery destinations require their own authorized setup
- GitHub owner/repository/visibility, original-code license and deployment host remain undecided; no push/publication/deployment has occurred

The Runtime stays unmodified. Manual memory editing is out of scope, not a blocked required feature. Source is managed by incremental local Git commits; no source ZIP delivery is planned.
