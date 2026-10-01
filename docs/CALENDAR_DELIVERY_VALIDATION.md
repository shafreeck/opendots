# Actual calendar due-time delivery and recovery

On 2026-09-30 at 16:39 UTC, the opt-in application test passed against the hash-verified,
unchanged official Morphz v0.1.3 executable. The model was a deterministic loopback
fixture, not a paid or real language model.

Run with:

```sh
OPENDOTS_RUNTIME_BINARY=/path/to/verified/morphz npm run test:runtime-calendar-delivery
```

The test creates one daily UTC rule limited to that same local date, at the next
minute boundary with at least 15 seconds of setup margin. It binds only the
fixture's no-auth local model account. It then closes the product BFF before the
native due time while keeping the isolated Runtime alive.

Evidence from the successful run:

- One native due trigger and one local scripted model request
- Ordinary assistant reply persisted by Runtime and observed through the real
  typed Session IO adapter before reopening the BFF
- BFF recovery displays exactly one reminder with the original committed event ID
- A second BFF restart preserves that event ID and does not repeat inference
- The original occurrence remains in product history
- Zero paid calls; the fixture requested no physical tools or exec

No clock override, Runtime source patch, direct native database write, desktop
control, external notification or sandbox assurance is involved. The disposable
processes/listeners/data are cleaned up. A successful local Session message does
not prove real-model quality, phone push delivery or real-device UI behavior.

## Setup corrections retained as evidence

Earlier fixture attempts were unsuccessful and are not counted as passes. The
first omitted the fixture Agent's account binding; another run was interrupted
before a terminal result. Later attempts incorrectly asked `deliver_message` to
emit a typed output from a scheduled root. At the pinned source,
`morphz/src/session_io/output.rs` requires an accepted typed root input for that
tool. A schedule has no such input contract. The final fixture follows the
supported ordinary-assistant-text path; `web_session_io.rs` projects committed
`chat/reply` events into Session IO. It also uses the product adapter's explicit
format negotiation and the real `/occurrences` history route.

The successful run required fixture corrections only. No product scheduler or
Morphz Runtime code was changed to make delivery pass. The new script is opt-in
because it waits for an actual minute boundary; default unit tests do not silently
start a Runtime or issue a model request.
