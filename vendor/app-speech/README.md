# Morphz application speech reuse

Source: https://github.com/morphz-ai/morphz/tree/7e8f7d81f8b00fd45544d94d5b9a321214633df1/application
Pinned commit: `7e8f7d81f8b00fd45544d94d5b9a321214633df1`
Copyright 2026 Newvar and the Morphz contributors. Apache-2.0.
Full license and original NOTICE are retained at `../../licenses/Morphz-Apache-2.0.txt` and `../../licenses/Morphz-NOTICE.txt`.

- `audio.ts`: original `packages/core/src/audio.ts`, unchanged except provenance header
- `environment.ts`: original `packages/application/src/environment.ts`, unchanged except provenance header. opendots calls it only when an operator explicitly configures `OPENDOTS_VOICE_ENV_FILE` (or its legacy plain-file alias `MORPHZ_APP_ENV_FILE`), never its implicit project-file fallback
- `speech.ts`: adapted from `packages/application/src/speech.ts`. Keeps original Doubao Agent Plan endpoint/resource IDs, request headers, WAV/PCM framing, compressed ASR framing, response parser, bounded TTS chunk parsing, cancellation and one-request-per-principal rules

Local modifications to `speech.ts`: replaces the application-wide DomainError and small Zod schemas with equivalent local bounded shape checks; changes TypeScript parameter properties to Node's erasable syntax; renames the class to `DoubaoSpeechProvider`; uses the injected WebSocket factory for both one-shot ASR and duplex. No additional provider or fallback is added.

The optional `SpeechProvider.openStream` and `SpeechDuplex.ready/write/finish/close` implementation is restored from that same pinned application's `speech.ts`. It sends raw PCM16, 16 kHz mono, using the source's full-result protocol and resolves `ready` after sending its request without requiring an upstream ACK. The 6400-byte even PCM frame limit is copied from the pinned `packages/core/src/speech-stream.ts`; no Runtime implementation is imported or changed. The adapter explicitly enforces a 10-second opening timeout, a 12-second finish timeout, and a 160000-byte outgoing buffer limit including the next encoded frame. WebSocket redirects are disabled for both ASR modes.

Local transport hardening adds required `SpeechDuplex.closed`, which resolves only on the socket's actual close event. Requesting termination alone does not settle it successfully: missing acknowledgment rejects after two seconds, and termination exceptions reject with a redacted error. The principal remains reserved until an actual close event, including after a timeout or exception. One-shot ASR preserves its prior public result/error settlement timing, while sharing that same socket-lifetime reservation with streaming and TTS. Reservations are identity-checked so a late event cannot release a newer operation. Cancelled openings, repeated finish/close calls, duplicate opens, late results/errors, synchronous send exceptions, asynchronous send callback errors, and consumer callback exceptions are fenced; readiness/closure promises have rejection handlers during cancellation. HTTP error status values are validated before inclusion in user-visible errors.

These are product-layer application modules. No Morphz Runtime source or binary is modified. Tests use only synthetic keys and mocked transports; no vendor request or capability/paid quota probe is performed by configuration.

`test/voice-stream-provider.test.ts` exercises the protocol, limits, cancellation, timeout, closure acknowledgment, principal exclusion and redaction with local EventEmitter sockets and deterministic mock clocks; `test/voice-provider.test.ts` preserves one-shot compatibility coverage.
