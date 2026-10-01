# Streaming dictation lifecycle

This extends the existing explicit one-shot voice feature with real incremental
ASR through the pinned Morphz application speech provider. It is dictation into an
editable draft. `duplex` remains `false`: there is no automatic conversation turn,
concurrent ASR/TTS, VAD, spoken barge-in, or automatic read-aloud.

## Existing source and reuse

The unchanged upstream checkout is pinned to
`7e8f7d81f8b00fd45544d94d5b9a321214633df1`:

- `application/packages/application/src/speech.ts`: optional
  `SpeechProvider.openStream(principal, result, error)` and the existing Doubao
  Agent Plan PCM WebSocket protocol. `SpeechDuplex` supplies `ready`, `write`,
  `finish`, and `close`. The local adapter adds an acknowledged `closed` promise
- `application/packages/core/src/speech-stream.ts`: bounded PCM frames and
  `open/push/read/finish/cancel` commands
- `application/packages/application/src/speech-stream.ts`: ephemeral scoped
  streams, exact latest-frame replay, partial/final results and expiration
- `application/apps/web/src/live-dictation.ts`: independent frame writes and
  transcript reads, backpressure and no automatic audio replay
- `application/tests/speech-stream.test.ts`: upstream synthetic stream fixtures

The adapted provider retains its Apache-2.0 source notice, license and NOTICE in
`vendor/app-speech`. Runtime source and binary are unchanged. These application
speech APIs are not Runtime audio APIs.

The existing TTS implementation receives provider chunks but returns a complete
WAV to the application. Its shared principal lock prevents simultaneous ASR and
TTS provider operations. Stopping dictation does not cancel native work or undo
anything already sent to a provider.

## Product contract

The existing private BFF listener handles `POST /api/voice/stream`, with owner
browser authentication, CSRF, a 40,000-byte JSON body limit, and the server's fixed
verified native identity. A stream additionally belongs to the exact browser
owner session. Browser payloads cannot select a Principal, native Session,
provider URL or credential. Streaming requires configured owner authentication;
the existing one-shot interface keeps its existing behavior.

Commands are strict objects:

- `open`: `{id, action:'open', consent:true}`
- `push`: `{id, action:'push', sequence, data}`
- `read`: `{id, action:'read', after}`
- `finish` / `cancel`: `{id, action}`

`id` is a lowercase UUID. Audio is 16 kHz mono signed PCM16 little endian. `data`
is a JSON byte array, nonempty, even length, at most 6,400 bytes. Sequence starts
at 1. An exact duplicate of the most recently accepted frame is acknowledged
without another provider write; a changed duplicate or sequence gap terminates
the stream. This mechanism does not authorize automatic audio retransmission.
Only the last frame digest is retained for comparison, not its raw audio.
`receivedSequence` confirms local frame admission into the bounded provider
transport; it is not a provider recognition or delivery acknowledgment.

Responses contain `id`, monotonic `revision`, `status`, cumulative replacement
`text`, `receivedSequence`, `expiresAt`, `maximumSeconds`, `reviewRequired:true`,
`sentToChat:false`, and `duplex:false`. A safe `errorCode` may be present. Status is
`opening`, `listening`, `finishing`, `complete`, `cancelled`, or `error`. Provider
error bodies, socket errors and credentials are never returned.

`read` waits at most five seconds and permits one pending reader. `finish` stops
further frame admission and normally returns `finishing`; read until final or
error. Partial text is always unsent. The browser discards it on failure; any
remaining server-side partial text is transient and expires with the entry.
`cancel` closes capture/provider work and discards the server transcript, even
when invoked before an opening request settles. A short-lived tombstone prevents
that delayed open from starting a provider connection.

The default visible capture limit is 60 seconds; configuration cannot exceed 120
seconds. The server bounds both elapsed capture time and total admitted PCM.
Fifteen seconds without audio expires a stream; finishing has a 12-second bound.
The browser must allow only one in-flight push and at most 32,000 bytes of queued
PCM, stopping on overflow. Completed entries expire after 30 seconds; the service
holds at most 128 entries. No audio or draft transcript is written to SQLite,
localStorage, disk, or a replay queue.

## Consent and cancellation

Before opening a provider connection or transmitting audio, the user must
explicitly start streaming with disclosure of the existing configured provider,
destination, possible charges, continuous transmission until stop, and the
visible time limit. Browser microphone permission is separate. Existing
one-shot recording consent does not start streaming.

Close, navigation/background, logout/device revocation, premature HTTP disconnect,
and application shutdown stop further audio admission and close the provider.
Late results are fenced and cannot repopulate a cancelled transcript. There is no
automatic reconnect, audio replay, chat send or TTS. Provider-side processing of
already transmitted data cannot be recalled; provider retention follows its own
policy. Releasing buffers does not promise physical memory zeroization.

`VoiceStreamService.revokeSessions(deviceSessionId?)` starts cleanup synchronously;
its promise settles through `allSettled`, so logout itself is not blocked by a
socket. Omitted ID revokes every stream. `close()` stops admission, aborts pending
identity reads, waits admitted handlers and bounded provider-closure settlement, then clears entries.
The production provider resolves `closed` only after a socket close event; its
bounded termination timeout reports uncertainty and keeps the Principal reserved
until actual closure. Calling `terminate()` alone is not a closure receipt.

Reviewing and sending a transcript uses the existing durable chat admission and
its exact request key. An uncertain send retains that key and payload. Native
admission, committed output and task completion remain distinct. This slice adds
no voice-specific native turn-cancel shortcut or speculative turn coordinator.

## Validation boundary

The focused service run passes 19 deterministic tests covering frame bounds,
ordering/deduplication, owner/device isolation, late open/cancel, auth revocation,
read abort, duration/idle/finalization bounds, error redaction, no automatic replay,
and provider-close draining. Adapter and BFF/browser integration evidence is
reported separately when those final suites are frozen.

No microphone, actual provider connection, recognition quality, playback quality,
billing or full-duplex call was tested. A configured capability is not a live
provider health check. Native mobile microphone support remains disabled by its
existing client policy.


## Integrated validation

The lead ran54 combined service/provider/HTTP/one-shot regression tests. HTTP
fixtures prove owner auth and CSRF, explicit consent, exact device scope, bounded
frame bodies and duplicate handling, no automatic chat command, logout cleanup,
long-poll transport interruption and server-close draining. Static helper delivery
is authenticated. Provider tests use local synthetic sockets, not the vendor.

The streaming capture helper has18 focused tests: 48kHz/44.1kHz chunk-invariant
resampling, little-endian frame bounds, serialized sends, bounded queue overflow,
late permission/setup results, stop/cancel ordering, timers and device/context
interruption. The helper releases the microphone before draining on Stop;
Cancel aborts/discards. Its frame callback borrows bytes only until settlement.

The integrated browser UI retains the original one-shot mode and adds a separate
ongoing-transmission confirmation. It distinguishes partial text from final,
editable, unsent text; graceful local/server Stop waits for final without aborting
an active read, while cancellation closes the transport. Delayed setup completion
after a graceful stop cannot cancel an otherwise valid final transcript. All
existing identity/modal generation fences remain in place. Final aggregate and
independent client-review results are recorded in VALIDATION_CURRENT.md once
complete. None of this substitutes for live microphone/provider/device proof.
