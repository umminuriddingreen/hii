# Desktop release readiness

Audit date: 2026-08-04 (America/Los_Angeles)

Repo: `/Users/ummi/hii`

Branch: `release/new-user-ready`

Release version: `0.1.0`

Targets: Apple Silicon macOS 13+ and x64 Windows 10/11

## Verdict

HII has one Tauri desktop codebase for macOS and Windows. The packaged app owns
its local server and AII daemon, initializes an empty user profile, and does not
depend on the source checkout. Activation now fails closed until an installed
agent is authenticated and the user selects at least one supported project
file.

The macOS package passes the isolated packaged-app proof described below. A
native Windows GitHub runner builds an NSIS current-user installer and must
install, launch, expose the local API, and start/stop the embedded daemon before
the installer artifact is retained.

Public distribution trust remains a separate release gate:

- macOS needs an Apple Developer ID Application identity and notarization.
- Windows needs an Authenticode certificate and a signed-installer verification
  step before HII should claim a verified publisher or broadly promote the
  download.

HII does not instruct users to bypass Gatekeeper, SmartScreen, or Windows
Security.

## Current verification

### Product release gate

`npm run ci:full` passes. This includes Svelte checks, the full Vitest suite,
Rust CLI formatting, linting, compilation, 184 Rust tests, CLI regression, and
product smoke tests.

`npm run build:cloudflare` passes with the Windows and macOS download routes.
Those routes fail closed unless a versioned release manifest and matching
artifact exist in the bound R2 bucket.

### macOS packaged proof

`npm run build:tauri:mac` produces:

`src-tauri/target/release/bundle/macos/HII.app`

`npm run hii:packaged-app:check` passes with these properties:

- a copied app runs outside the source repository;
- an empty isolated runtime initializes successfully;
- the embedded AII daemon starts and stops;
- receipt state and content-addressed assets survive reinstall and restart;
- corrupt workspace state is preserved with an inspectable recovery path; and
- the copied app passes strict deep code-sign verification.

The current local signature is ad hoc. This proof does not establish Developer
ID, notarization, quarantine, Gatekeeper acceptance, or a second-Mac install.

### Windows packaged proof

`.github/workflows/windows-packaged-app.yml` runs on `windows-2025`, builds the
x64 NSIS installer, silently installs it for the current runner user, launches
the installed executable, checks `http://127.0.0.1:3042/api/knowledge`, and
starts/stops the embedded AII daemon. The workflow retains the installer for 14
days only when every step passes.

The installer uses Tauri's embedded WebView2 bootstrapper and does not require
administrator access. An unsigned successful CI artifact is suitable for
bounded owner testing, not a general-audience trusted release.

## Release gates

| Gate | macOS | Windows |
| --- | --- | --- |
| Native package builds | Passed locally | Required in native CI |
| Clean-user install/launch | Isolated packaged simulation passed | Required in native CI |
| Embedded local API | Passed | Required in native CI |
| Embedded AII start/stop | Passed | Required in native CI |
| Distribution signing | Blocked: Developer ID unavailable | Blocked: Authenticode material unavailable |
| Public trust verification | Blocked: notarization/Gatekeeper | Blocked: signed publisher/SmartScreen |
| Website download route | Implemented, artifact absent | Implemented, artifact absent |

## Human/account actions

- Install an Apple Developer ID Application certificate and configure an
  `xcrun notarytool` keychain profile before running the existing macOS public
  release command.
- Provision a Windows code-signing certificate through GitHub Actions secrets,
  sign the executable and NSIS installer, and verify the Authenticode chain in
  the Windows workflow.
- Upload only the final verified artifacts and their SHA-256 manifests to R2;
  then deploy the website and test each download from a separate machine.

Until those trust gates pass, keep unsigned packages private and label any
owner-only installation as a test build.
