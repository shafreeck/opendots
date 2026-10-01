# Memory scope

Morphz Runtime is strictly unmodified. Memory remains managed by the existing Morphz mechanisms and ordinary conversation. Users can tell the assistant about a factual correction or preference in chat.

The product provides read-only Frame search and provenance inspection through supported existing APIs. There is no manual create/revise/retire/protect/restore editor or custom memory-write endpoint in the current scope. Do not treat this as a blocked required feature or promise a future editor.

An experimental additive Runtime patch was withdrawn before release or successful full compilation. It is not in this source tree or any build/dependency path. App code depending on it was removed in a normal reversible Git commit; history was not rewritten. The canonical Morphz baseline remains unchanged.
