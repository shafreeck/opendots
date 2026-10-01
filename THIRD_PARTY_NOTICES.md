# Third-party notices

## Morphz

Interoperation baseline: 7e8f7d81f8b00fd45544d94d5b9a321214633df1.
Original upstream source is generally Apache-2.0, subject to LICENSE_SCOPE exceptions. See licenses/Morphz-Apache-2.0.txt and licenses/Morphz-NOTICE.txt. This project is independent and not endorsed by Morphz.

## ws 8.21.3

MIT. Source: https://github.com/websockets/ws . Full copyright/license notice: licenses/ws-MIT.txt. Used for WebSocket server transport.

## noVNC 1.7.0

MPL-2.0. Source: https://github.com/novnc/noVNC . Full license: licenses/noVNC-MPL-2.0.txt. Distributed dependency files retain upstream headers; no modifications are currently made to noVNC source. When shipping, retain the source-availability/license obligations for covered files and review the dependency's additional vendor notices. noVNC's MPL license does not select a license for original opendots files.

This file records current direct dependencies, not a completed distribution/SBOM audit. OS/browser/container components need their own release bill of materials before publication.

## Adapted Morphz application speech foundation

`vendor/app-speech/{speech,audio,environment}.ts` selectively adapts Apache-covered application modules from the same pinned Morphz revision. The Runtime source itself is unchanged. See `vendor/app-speech/README.md` for exact original paths and product-layer modifications; retain `licenses/Morphz-Apache-2.0.txt` and `licenses/Morphz-NOTICE.txt` when distributing these files. Provider service terms and data retention are separate from the source license.

## Optional Electron desktop client

`apps/desktop` pins Electron 44.5.1. Its npm lockfile declares MIT for the Electron
package; the downloaded binary additionally contains Chromium and other
third-party software with separate notices. No Electron binary is vendored here.
Collect the actual binary's full notices and platform dependency inventory before
distribution. See `docs/DESKTOP_CLIENT.md` and `docs/DEPENDENCIES.md`.
