# Opt-in web speech foundation

This is a product-layer, one-shot speech feature. It does not modify Morphz Runtime, create a second conversation, or provide a full-duplex phone/native client. The existing durable chat input is still the only way reviewed transcription becomes an assistant request.

## Availability and explicit actions

Speech is disabled by default. Configuration reads do not access a provider, check quota, or perform a paid probe. `available` means the feature is enabled and a nonblank provider credential exists; it does not prove provider access, quota, network health, recognition quality or playback quality.

The browser asks for microphone permission only after an explicit user action. Capture is bounded mono 16kHz signed 16-bit PCM in canonical WAV: recommended ten seconds, maximum thirty seconds / 960,044 bytes. The provider receives audio only after the user explicitly submits that recording. Stopping a capture must not silently send it. Cancel stops local capture/request; it cannot recall bytes already sent to the provider or undo a provider charge.

Transcription returns editable, **unsent** text with `reviewRequired:true` and `sentToChat:false`. The user reviews/edits and uses the existing chat Send action and durable idempotency key. There is no automatic retry or automatic chat submission. The normal chat length bound still applies; an overlong transcript must be edited, never silently truncated.

Read-aloud is a separate explicit action. The server resolves an exact `output.committed` message from the fixed Session and sends its actual text, at most 2,000 characters, to speech synthesis. Browser-provided arbitrary text, URLs, paths, Sessions and Principals are not accepted. Overlong replies fail before provider transmission; they are not silently shortened. There is no automatic reading of incoming chat messages.

## Server-only provider configuration

The reused Morphz application adapter currently supports **Doubao Agent Plan** speech. Chat model BYOK configuration does not implicitly authorize or configure speech. No fallback to a chat provider, browser speech-recognition service, or another endpoint is implemented.

1. The operator explicitly enables the feature with `OPENDOTS_VOICE_ENABLED=1`
2. Supply `DOUBAO_API_KEY` to the server process through user-managed private configuration. This is the application's existing speech variable, not a new opendots secret database
3. Alternatively, set `OPENDOTS_VOICE_ENV_FILE` to an absolute, privately managed environment file. The locally copied allowlist loader imports only `DOUBAO_API_KEY`; existing host values, including an intentionally blank value, take precedence

Do not enter keys in chat or client-side configuration. There is no browser/API route for setting this credential. opendots does not inspect the Runtime Secret Store, discover other credentials, or automatically scan the repository/home directory for `.env` files. An explicitly configured file is read only when voice is enabled. Restart the server after changing its configuration.

The exact pinned adapter sends requests to `openspeech.bytedance.com`:

- ASR: `wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_async`, resource `volc.seedasr.sauc.duration`
- TTS: `https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional`, resource `seed-tts-2.0`

Credentials remain in server-side `X-Api-Key` headers. URLs and endpoints are fixed, redirects disabled. The provider may charge for explicitly requested operations. Access and retention terms are the provider's responsibility and must be reviewed by the operator/user.

## Retention and identity

Raw audio and playback bytes remain ephemeral in opendots memory and browser object URLs; they are not written into product commands, SQLite, audit entries or application logs. Unsent transcription is not automatically written to the product database. Once the user explicitly sends reviewed text, normal chat persistence applies.

`privacy.audioStored:false` describes **opendots local retention only**. It is accompanied by `retentionScope:'opendots_local_only'` and `providerRetention:'provider_policy'`. No downstream deletion or zero-retention guarantee is made for the speech provider. Browser capture/playback buffers and object URLs should be released on completion, cancellation or navigation; this does not guarantee physical zeroization of memory.

Before transmitting content, the host revalidates the fixed saved Runtime Principal, Session and Context. Read-aloud then resolves only committed typed-IO assistant messages from that Session. Source identifiers are references, not bearer tokens or a grant to read arbitrary content.

## HTTP contract

All routes retain local Host/Origin restrictions. Mutating routes require the normal `x-opendots-csrf` header. Responses use `Cache-Control:no-store`; audio also uses `X-Content-Type-Options:nosniff`. No identity or token query parameters are accepted.

- `GET /api/voice`: returns enabled/configured/available status; fixed provider and destination disclosure; capture and read-aloud limits; privacy labels; `verification:'configuration_only'`. `operations.duplex` is always false
- `POST /api/voice/transcribe`: `Content-Type:audio/wav`, bounded canonical WAV body, and explicit `x-opendots-voice-consent:transcribe`; returns `{text,reviewRequired:true,sentToChat:false}`
- `POST /api/voice/read-aloud`: JSON `{messageId,consent:true}`; returns bounded `audio/wav` for the authorized committed message

Client disconnect and server shutdown abort active speech. ASR uses a ten-second handshake timeout, a ninety-second total deadline, and a 1,000,000-byte WebSocket/decompressed-response bound. TTS has a sixty-second abort deadline and an eight-MiB upstream response bound. The provider permits one speech operation per bound Principal at a time. There are no automatic retries after uncertain outcomes. Provider error bodies and credentials are not relayed to the browser.

## Source reuse and evidence

Upstream is read-only and unmodified. The vendored application modules are Apache-2.0 with provenance and adaptation details in `vendor/app-speech/README.md`, plus the retained Morphz license and NOTICE.

Reused from pinned commit `7e8f7d81f8b00fd45544d94d5b9a321214633df1`:

- `application/packages/core/src/audio.ts`: canonical WAV/PCM utilities and capture/TTS bounds
- `application/packages/application/src/speech.ts`: fixed Doubao protocol, ASR compressed framing/response parser, bounded TTS parser, cancellation, request serialization
- `application/packages/application/src/environment.ts`: server-side allowlisted speech configuration loader

Provider, service and HTTP tests use synthetic keys, in-memory/synthetic audio, mocked HTTPS/WebSocket transports and a mocked Runtime contract. They verify bounds, framing, source scope, consent, error redaction, no retries, no automatic chat dispatch, disconnect/shutdown cancellation and no audio/unsent-transcript database retention. These tests do **not** establish live provider connectivity, microphone permission/capture quality, real recognition, speaker playback, billing, full-duplex calling or mobile/native support. No paid speech request was performed during implementation.


The opt-in ongoing dictation extension is described separately in
[VOICE_STREAMING.md](VOICE_STREAMING.md). It uses the supported application
streaming ASR protocol, requires its own ongoing-transmission consent and owner
login, and continues to report `duplex:false`. This document describes the
one-shot path; its original evidence does not substitute for streaming tests.

`MORPHZ_APP_ENV_FILE` remains an optional compatibility alias for an explicitly
selected plain environment file. `OPENDOTS_VOICE_ENV_FILE` takes precedence,
including an empty value that disables file loading. Neither variable refers to
a required Morphz application installation, service or checkout. With neither
selected, no project/application environment file is searched or loaded.
