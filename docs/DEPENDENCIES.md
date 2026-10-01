# Dependency provenance and release audit boundary

`node scripts/dependency-inventory.mjs > docs/npm-dependency-inventory.json`
rebuilds the offline npm inventory from the exact root, desktop and mobile lockfiles.
It includes lockfile paths, SHA-256 source digests, package versions, integrity
strings, declared license metadata and optional/development flags. It intentionally
omits registry URLs and arbitrary lockfile fields. Optional platform packages are
included even when not installed here. This is a reproducible input inventory,
not a complete binary SBOM, license opinion, vulnerability scan or release approval.

## Source and vendored notices

- Morphz source revision and unmodified-only policy: `morphz-source.lock.json`.
  Apache-2.0-covered code may be reused with its conditions; `LICENSE_SCOPE`
  exclusions cover marks/artwork and specified website/paper/IP content. See
  `docs/SOURCE_AUDIT.md`, root `NOTICE` and vendored provenance before distribution.
- Application speech modules: `vendor/app-speech`; source provenance and retained
  license/notice accompany the copies. They are application code, not a Runtime patch.
- noVNC: pinned npm package, declared MPL-2.0; distribution must retain the applicable
  notices and provide covered source as required. No source-license override is made.
- ws and Electron npm package: declared MIT metadata in lockfile. Electron's
  downloaded binary contains Chromium and other third-party components that need
  their own shipped notices and binary dependency inventory.
- Expo/React Native/WebView mobile JavaScript dependencies are pinned in their
  separate lockfile. CocoaPods, Gradle/AARs, Hermes and platform SDK outputs are
  not inventoried by npm; production JavaScript export is not a native binary SBOM.
- Native X11/helper and container packages, Playwright seccomp provenance and OS
  transitive dependencies are outside the npm inventory. See computer deployment
  files; a built image must be separately inventoried before release.

## Before public release

Choose the original opendots code license with the project owner; existing
`private:true` does not grant an open-source license. Produce inventories from the
actual built container and desktop artifacts, collect their license/NOTICE files,
run a current advisory audit against exact resolved versions, and review generated
artifacts for credentials and unrelated private material. No clean security/legal
bill of health is inferred from a successful offline inventory command. No package
install scripts, paid API calls, credential reads or publication are performed by
this script.

## Recorded registry advisory check

On 2026-09-30, `npm audit --package-lock-only --ignore-scripts --json` returned
zero known advisories for the root and desktop locks. The mobile lock returned
19 moderate affected package entries, all tracing to one `uuid` advisory rather
than 19 distinct vulnerabilities. Exact lock digests and selected results are in
[npm-advisory-check.json](npm-advisory-check.json).

The upstream [uuid advisory](https://github.com/uuidjs/uuid/security/advisories/GHSA-w5hq-g745-h8pq)
concerns caller-supplied output buffers in the v3/v5/v6 APIs. The resolved Expo
chain has no automatic compatible fix reported by npm. No forced major override
or dependency source patch was applied. This remains a recorded release review
item; bundling and tests do not establish absence of a reachable vulnerable path.
The check covers registry knowledge at that time, not native binaries, future
advisories, platform SDKs or complete exploitability analysis.
