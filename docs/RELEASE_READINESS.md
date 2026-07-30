# Mac release readiness

Audit date: 2026-07-30 (America/Los_Angeles)

Repo: `/Users/ummi/hii`

Branch: `refactor/svelte-parity`

Release version used by the Mac release script: `0.1.0`

Target observed: Apple Silicon (`arm64`), macOS 13.0 or newer

## Verdict

HII can currently build an Apple Silicon `.app` completely from local cached
dependencies. It cannot currently produce the signed, notarized downloadable
release described by the launch plan because this Mac has no valid code-signing
identity, neither release environment variable is configured, and no Apple
notarization run has been performed.

The app now has a repeatable packaged-app proof. It copies `HII.app` outside
the repository, starts the embedded Node/Svelte runtime with empty isolated
user data, writes a receipt workspace, replaces the app copy, verifies the
receipt after restart, and proves corrupt-workspace recovery. The first run of
that proof found that `yaml` was missing from the portable runtime; the build
now bundles it and the complete proof passes. This is not a substitute for a
downloaded, quarantined test on a second Mac.

The implemented public artifact is a ZIP containing `HII.app`,
`hii-bootstrap.sh`, and `INSTALL.md`. There is no `.dmg` build or release path.
If a DMG is a release requirement, that is code work, not an account-only
blocker.

## What an external Mac release requires

| Requirement | Current state | Implementation owner |
| --- | --- | --- |
| Build a self-contained production `HII.app` for the intended architecture and minimum macOS version. | Implemented locally. `npm run build:tauri` produced `src-tauri/target/release/bundle/macos/HII.app` for arm64 with minimum macOS 13.0. | `package.json`, `scripts/hii-tauri-build.mjs`, `src-tauri/tauri.conf.json` |
| Sign all executable content and the outer app with an Apple **Developer ID Application** identity, a secure timestamp, and the hardened runtime. Apply any entitlements required by the bundled runtime. | Nominal outer-bundle signing is implemented with `codesign --deep --options runtime --timestamp`, but it has not run here with a Developer ID identity. The fresh app is ad-hoc signed, has no team identifier, and is not suitable for external distribution. The bundled Node and native helper behavior under the hardened runtime is not verified. | `scripts/hii-macos-release.mjs`, `scripts/hii-tauri-build.mjs` |
| Verify the signed app before submission. | Implemented with `codesign --verify --deep --strict --verbose=2`; not exercised with a distribution signature. | `scripts/hii-macos-release.mjs` |
| Submit a supported container to Apple notarization and wait for acceptance. | Implemented for a temporary ZIP made with `ditto`; blocked because no configured notary profile was supplied and Apple services were intentionally not called in this audit. | `scripts/hii-macos-release.mjs` |
| Staple the notarization ticket to the app, validate the ticket, and have Gatekeeper accept the app. | Implemented with `stapler staple`, `stapler validate`, and `spctl`; not exercised. | `scripts/hii-macos-release.mjs` |
| Package the deliverable without losing the signed/stapled app. | Implemented for a final ZIP containing `HII.app`, `hii-bootstrap.sh`, and `INSTALL.md`. Not implemented for DMG. | `scripts/hii-macos-release.mjs`, `src-tauri/tauri.conf.json` |
| Record release identity and integrity metadata. | Implemented for the ZIP: version, platform, architecture, minimum macOS version, filename, bytes, SHA-256, signing/notarization claims, and creation time are written to `dist/releases/latest.json` after all preceding commands succeed. | `scripts/hii-macos-release.mjs` |
| Test the downloaded/quarantined artifact on a clean supported Apple Silicon Mac: Gatekeeper, launch, bundled runtime, bootstrap, first receipt, restart, and uninstall/data deletion. | A copied-app, isolated-user simulation now verifies bundled runtime startup, first receipt, reinstall/restart persistence, recovery, and strict ad-hoc signature integrity. A genuinely downloaded/quarantined second-Mac test, bootstrap, and uninstall/data deletion remain unverified. | `scripts/hii-packaged-app-smoke.mjs`, `docs/LAUNCH_AND_MONETIZATION.md`, `docs/INSTALL.md` |
| Put the verified artifact behind the public download action. | Required by “Build now”; not performed and outside this local code audit. | `docs/LAUNCH_AND_MONETIZATION.md` |

## Local trust and artifact state

Read-only local checks reported:

```text
HII_SIGNING_IDENTITY=unset
HII_NOTARY_PROFILE=unset
     0 valid identities found
Identifier=com.ummi.hii
Format=app bundle with Mach-O thin (arm64)
Signature=adhoc
TeamIdentifier=not set
exists: src-tauri/target/release/bundle/macos/HII.app
missing: src-tauri/target/release/bundle/dmg
missing: dist/releases
```

This proves that the Developer ID Application certificate and its usable
private key are not available as a valid code-signing identity on this Mac
today. The notary profile name is not configured in the current environment.
Because no profile name was supplied and Apple services were prohibited, the
existence or validity of any differently named keychain profile was not tested.

The release command was run with both release variables explicitly removed so
that it could only exercise its local preflight gate. It exited 2 before
building, signing, or contacting Apple:

```text
hii:release:mac is intentionally closed until distribution trust is configured.
Set HII_SIGNING_IDENTITY to an Apple Developer ID Application identity.
Set HII_NOTARY_PROFILE to an xcrun notarytool keychain profile.
The script will not create a public archive from an ad-hoc signed app.
```

## Build verification

### `npm run build`

- Result: PASS, exit 0.
- The Vite/SvelteKit production client and server builds completed.
- No build errors occurred, so there are no errors to reproduce verbatim.
- Warnings observed included the experimental `node:sqlite` warning, chunks
  larger than 500 kB, and `node:sqlite` being treated as an external dependency.

### `CARGO_NET_OFFLINE=true npm run build:tauri`

- Result: PASS, exit 0.
- `CARGO_NET_OFFLINE=true` forced Cargo to use cached local dependencies.
- Produced:
  `src-tauri/target/release/bundle/macos/HII.app`
- Tauri reported one `.app` bundle. The wrapper then applied and verified an
  ad-hoc signature (`codesign --sign -`).
- No build errors occurred, so there are no errors to reproduce verbatim.
- This result does **not** verify Developer ID signing, hardened-runtime
  behavior, notarization, stapling, Gatekeeper acceptance, or launch on another
  Mac.

### `npm run hii:packaged-app:check`

- Result: PASS, exit 0.
- Copied the built 196 MB `HII.app` into a temporary Applications directory
  outside `/Users/ummi/hii`.
- Started only the app's embedded Node and SvelteKit resources against a new
  isolated `HII_RUNTIME_DIR`.
- Created and persisted a version 1 workspace receipt, replaced the copied app,
  restarted the packaged runtime, and verified the same receipt and revision.
- Injected a malformed workspace, received the expected recovery response, and
  verified that HII preserved the unreadable source at the reported recovery
  path.
- Verified the copied app with
  `codesign --verify --deep --strict --verbose=2`.
- The initial run failed because `yaml` was not packaged. Adding `yaml` to the
  portable dependency copy fixed the clean-runtime failure.
- This remains a same-Mac simulation. It does not prove Developer ID,
  notarization, quarantine, Gatekeeper, another CPU architecture, or another
  physical Mac.

## Blocked on Ummi (human/account actions)

- [ ] Enroll in or confirm active Apple Developer Program membership, accept
  any current agreements, and ensure the account has authority to issue
  Developer ID certificates.
  - Owner: `docs/LAUNCH_AND_MONETIZATION.md`

- [ ] Create/install a **Developer ID Application** certificate and matching
  private key in the build Mac's keychain. Re-run
  `security find-identity -v -p codesigning` and require at least the intended
  valid identity before attempting release. Current result: `0 valid identities
  found`.
  - Owner: `docs/LAUNCH_AND_MONETIZATION.md`,
    `scripts/hii-macos-release.mjs`

- [ ] Create a `notarytool` keychain profile using the chosen Apple
  authentication method, then set `HII_SIGNING_IDENTITY` and
  `HII_NOTARY_PROFILE` to the exact local identity/profile names. Do not put
  credentials in the repo.
  - Owner: `docs/LAUNCH_AND_MONETIZATION.md`,
    `scripts/hii-macos-release.mjs`

- [ ] After the code items below are resolved, explicitly authorize and run
  `npm run release:mac`. Review the notarization result and retain the release
  archive, `latest.json`, and SHA-256. This audit did not contact Apple.
  - Owner: `package.json`, `scripts/hii-macos-release.mjs`

- [ ] Transfer the final artifact through the intended download channel and
  test it as a genuinely downloaded/quarantined file on a clean Apple Silicon
  Mac. Confirm Gatekeeper acceptance without security workarounds, application
  launch, bundled runtime startup, bootstrap behavior, first real receipt,
  restart persistence, and documented uninstall/local-data deletion.
  - Owner: `docs/INSTALL.md`, `docs/LAUNCH_AND_MONETIZATION.md`

- [ ] Configure the public download location and connect the download CTA only
  after the signed/notarized artifact and clean-Mac evidence pass.
  - Owner: `docs/LAUNCH_AND_MONETIZATION.md`

## Code work remaining

- [ ] Decide whether ZIP is the release contract or whether DMG is mandatory.
  If DMG is required, add a `dmg` bundle target and extend the release script
  to assemble the intended contents, sign the DMG, submit/validate its
  notarization, staple it, Gatekeeper-check it, and hash the final DMG. Today
  `bundle.targets` is `["app"]`, the release script emits
  `HII-0.1.0-macos-arm64.zip`, and no DMG path exists.
  - Owner: `src-tauri/tauri.conf.json`,
    `scripts/hii-macos-release.mjs`, `docs/INSTALL.md`

- [ ] Make distribution signing of embedded executable content deterministic.
  The current release implementation relies on one outer
  `codesign --deep` pass. Explicitly inventory/sign and verify the bundled Node
  runtime, native modules/helpers, and the outer app in the correct order (or
  configure Tauri to do so), and add only the entitlements proven necessary for
  those components under the hardened runtime.
  - Owner: `scripts/hii-macos-release.mjs`,
    `src-tauri/tauri.conf.json`

- [x] Add a single local release-candidate command that runs the full product
  and CLI gates, builds `HII.app`, and exercises the isolated packaged-app
  proof. `npm run ci:release-candidate` now provides that gate, with a manual
  macOS GitHub workflow that does not upload or publish the artifact.
  `release:mac` itself still invokes only `build:tauri` before signing.
  - Owner: `package.json`, `scripts/hii-macos-release.mjs`,
    `docs/LAUNCH_AND_MONETIZATION.md`

- [ ] Resolve or explicitly document the version source mismatch:
  `package.json` is `0.0.1`, while `src-tauri/tauri.conf.json` and the release
  filename use `0.1.0`. A public build should have one intentional release
  version.
  - Owner: `package.json`, `src-tauri/tauri.conf.json`,
    `scripts/hii-macos-release.mjs`

- [ ] Extend the repeatable packaged-app smoke with the final distribution
  evidence: exact archive filename/hash, Developer ID authority/team,
  notarization and staple validation, Gatekeeper result, archive contents,
  bootstrap, and uninstall/data deletion. The local runtime, receipt,
  reinstall/restart, recovery, and ad-hoc signature checks are now automated;
  the final downloaded clean-Mac execution remains a human release gate.
  - Owner: `scripts/hii-macos-release.mjs`,
    `scripts/hii-packaged-app-smoke.mjs`,
    `docs/LAUNCH_AND_MONETIZATION.md`

## Top three blockers to a downloadable build

1. **Apple distribution trust is unavailable locally:** no valid code-signing
   identity is installed, and neither required release variable is configured.
2. **There is no DMG pipeline:** current code produces only an ad-hoc local
   `.app`, and the gated public release path would produce a ZIP.
3. **There is no signed/notarized second-Mac proof:** local isolated-user,
   receipt, reinstall/restart, recovery, and ad-hoc signature behavior now pass,
   but Apple submission was not authorized, `dist/releases` does not exist, and
   Gatekeeper/first-run behavior has not been tested from a downloaded artifact
   on another Mac.
