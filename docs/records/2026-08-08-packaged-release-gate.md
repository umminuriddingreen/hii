# Packaged desktop release gate — handoff

Date: 2026-08-08
Branch: `release/new-user-ready`
HEAD at handoff: `7f05391`
Nothing pushed. `origin/release/new-user-ready` is 24 commits behind local.

## Commit accounting correction

The previous report said 11 new commits since `d2a4d30`. It was 10. No SHA was
omitted; the count was wrong. `git rev-list --count d2a4d30..8a4ea64` = 10.

## What this pass answered

Not "can HII become an agentic artboard" — that spine was built and tested in
the previous pass. This pass asked whether **the packaged application a new user
launches** delivers it without the development environment. It did not, in three
ways. Two are fixed.

## Build provenance

| | |
| --- | --- |
| source | `8a4ea64`, clean except `.playwright-cli/` |
| node / npm | v22.22.0 / 10.9.4 |
| rustc / cargo | 1.97.1 |
| tauri-cli | 2.11.4 |
| macOS / arch | 26.5.2 (25F84) / arm64 |
| command | `npm run build:tauri` (→ `tauri build --bundles app`, then ad-hoc `codesign`) |
| artifact | `src-tauri/target/release/bundle/macos/HII.app`, 195 MB, 1010 files |
| bundle id / version | `com.ummi.hii` / 0.1.0, `LSMinimumSystemVersion` 13.0 |

No DMG, no updater artifacts, nothing in `dist/releases` — `npm run release:mac`
was deliberately not run (it submits to Apple).

## Defects found in the packaged app

### 1. The daemon could not start at all — FIXED (`1d0258c`)

`aii/daemon/hiid.mjs` imports `../model-runtime/profiles.mjs`. The packaging
manifest is a hand-listed set of directories and was never updated when that
import was added. The bundle built, signed, launched, and then failed at the
first agent run:

```
ERR_MODULE_NOT_FOUND .../HII.app/Contents/Resources/hii-app/server/aii/model-runtime/profiles.mjs
```

Every agent run, capability job and variant in the shipped product was
unreachable. `hiid` also resolves its own `ROOT` to the staged server directory,
so `config/native-model-profiles.json` was being read out of the source checkout;
it now travels with the bundle.

The build now refuses to produce a bundle whose staged modules cannot resolve
each other, and `tests/unit/packaged-resource-closure.test.ts` asserts the same
closure without needing a Tauri build.

### 2. Closing the workspace window bricked the app — FIXED (`7f05391`)

`WindowEvent::CloseRequested` called `stop_hii_server` for *any* window. The
Notch is `closable(false)`, so the application never exited — it stayed alive
with an ambient surface pointing at a dead server, and every route back went
through `get_webview_window("main")` and failed.

Observed before the fix: main window closed → server refused → only `HII Notch`
remained → no recovery. **The user's own running instance (pid 665) was in
exactly this state when this pass started.**

Fixed by reopening the main window on demand (`ensure_main_window`) and stopping
the server on application exit rather than on any window close.

### 3. An abrupt exit orphaned the server — FIXED (`7f05391`)

`kill -9` on the app left the node server alive, reparented to pid 1, still bound
to port 3042 and still holding the user's real `~/.hii` open. Crashes and Force
Quit are ordinary events, so this accumulates. The server now watches
`HII_SUPERVISOR_PID` and exits when that process is gone.

## Packaged proof actually executed

All against an installation-style copy outside the repo, with an isolated `HOME`.
The user's `~/.hii` was verified untouched (1 receipt before and after).

| Gate | Result |
| --- | --- |
| cold launch from installation-style path | both windows: `HII` 1440×960, `HII Notch` 230×26 at top centre |
| packaged resources resolve | server spawned, `/` and `/notch` both 200 — real content, not a blank webview |
| no source-checkout dependency | ran with the repo untouched, isolated `HOME` |
| launch stderr | empty — no shortcut-registration or resource errors |
| global shortcut ⌘⇧Space | Notch expanded 26 → 160 |
| focus loss | Notch collapsed 160 → 26 |
| close main window (after fix) | server stays 200, app alive |
| reopen via HII ▸ Open or Focus HII Workspace | window recreated at 1440×960 |
| Quit HII | app and server both gone, port released |
| relaunch | both windows return, `/api/workspace` 200, isolated runtime intact |
| `npm run hii:packaged-app:check` | ok — daemon start/stop, reinstall persistence, asset dedup, corrupt-workspace recovery, strict codesign, orphan supervision |
| `npx vitest run` | 512 passed, 82 files |
| `cargo clippy` (src-tauri) | clean |

## Signing state — be precise about this

The bundle is **ad-hoc signed**. It is not Developer ID signed, not notarized,
not stapled.

```
CodeDirectory flags=0x2(adhoc)
Signature=adhoc
TeamIdentifier=not set
entitlements: none
hardened runtime: not enabled
```

`spctl -a -vv` returns "accepted", but also `override=security disabled` —
Gatekeeper assessment is globally off on this machine, so **that acceptance is
not evidence of distributability.**

### Still required before notarization can be attempted

1. A Developer ID Application identity in the keychain (`HII_SIGNING_IDENTITY`).
2. An `xcrun notarytool` keychain profile (`HII_NOTARY_PROFILE`).
3. Hardened runtime (`--options runtime`) and a secure timestamp.
4. **Entitlements file** — none exists today. At minimum the bundled `node` and
   `node-pty` need library-validation handling under hardened runtime.
5. **`NSMicrophoneUsageDescription` in Info.plist** — absent. Voice capture in
   the packaged app cannot work without it; TCC will refuse.
6. Nested Mach-O signing. `Contents/Resources/hii-app/bin/node` is currently
   signed by **team HX7739G8FX** (Node's own identity), not Ummi's. It must be
   re-signed. `node-pty`'s `darwin-arm64/pty.node` and `spawn-helper` are ad-hoc.
   Apple wants nested code signed inside-out, not via `--deep`; `hii-macos-release.mjs`
   currently uses `--deep`.
7. Version alignment: `package.json`, `package-lock.json` and `tauri.conf.json`
   must all agree (the release script enforces this).

`scripts/hii-macos-release.mjs` already refuses to build a public archive
without (1) and (2). That gate is correct and should stay.

## Not done — the honest list

- **The packaged end-to-end artboard run was not executed.** The script exists at
  `/private/tmp/claude-501/-Users-ummi/eb3e8f88-8c1e-4255-b492-e096fe038619/scratchpad/artboard-packaged.mjs`
  but was not run to completion. Selection handoff, ContextRef review, grants,
  variant branching, lineage and restart are proven **in-process** (512 tests)
  and the packaged server is proven to boot, serve and run its daemon — but the
  full spine has not been driven through the packaged binary.
- **Microphone was never exercised.** No `NSMicrophoneUsageDescription`, so it
  cannot be. Voice capability status stays `partial` — correctly.
- **Notch states**: only IDLE, expanded/collapsed and focus-loss were exercised
  in the packaged app. The other ten states were not driven through real UI.
- **No packaged Workspace UI interaction** — no canvas clicks, no variant button,
  no approval panel driven in the packaged webview.
- The Notch's expanded panel still shows dashboard-level history.
- The native model runner (`target/release/hii-native-runner`) is not bundled.
  Its absence is reported honestly as `not-built`, but the hint says
  `npm run runner:build`, which is meaningless to a packaged user.

## Next, in order

1. Run the packaged artboard proof end to end (Ollama must be running; use
   `HII_PROOF_MODEL=qwen3:4b`).
2. Add `NSMicrophoneUsageDescription` and an entitlements file, rebuild, then
   exercise microphone permission interactively.
3. Replace `--deep` signing in `hii-macos-release.mjs` with inside-out nested
   signing, re-signing the bundled `node`.
4. Then, and only then, attempt notarization.

## Note for whoever picks this up

The app bundle at `src-tauri/target/release/bundle/macos/HII.app` was rebuilt
several times during this pass while the user's instance (pid 665) was running
from that same path. That instance is stale and was already in the broken
post-close state. It should be quit and relaunched from a fresh build.
`/Applications/HII.app` was not touched.
