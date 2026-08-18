# HII Bar — always-available macOS surface

A lightweight agent app that brings HII into the app already in front of you.
It remains available in the background; it does not continuously capture the
screen or replace Spotlight.

Per [ADR 004](../docs/decisions/004-cli-first-hii-runtime.md) this is a **thin
window onto the Rust CLI**, not a second runtime. Plain chat spawns

```
hii ask --jsonl <message>
```

and explicit governed commands spawn

```
hii run --cwd <workspace> --jsonl --stream --autonomy local-full \
        --authority <read-only|workspace> [--outcome informational] <goal>
```

and renders the JSONL stream. No agent logic lives in Swift.

## Layout

| Path | What it is |
| --- | --- |
| `Sources/HiiBarCore/JSONLMapping.swift` | Mirror of `jsonl_user_message` / `jsonl_receipt_path` in `src-tauri/src/lib.rs` |
| `Sources/HiiBarCore/CanvasMode.swift` | Mirror of `lib/workspace/canvas-modes.ts` (modes, authority, `modeIntent`) |
| `Sources/HiiBarCore/CLILocator.swift` | Mirror of `hii_binary` resolution order + `default_workspace_root` |
| `Sources/HiiBarCore/RunInvocation.swift` | The argument vector handed to `hii` |
| `Sources/HiiBarCore/Preferences.swift` | Workspace + mode, persisted to `~/.hii/bar/preferences.json` |
| `Sources/HiiBarCore/TranscriptStore.swift` | Session transcript JSONL under `~/.hii/bar/sessions/` |
| `Sources/HiiBar/` | AppKit cursor panel, status item, hotkey, and the `Process` runner |
| `Tests/HiiBarCoreTests/` | Unit tests pinning every branch of the mappings above |

**The four `Core` mirrors are copies of logic that lives elsewhere.** If the
Rust or TypeScript side changes, change these and their tests in the same
patch: two surfaces describing the same run differently is a proof bug.

## Build

```bash
node scripts/hii-bar-build.mjs            # debug build + .app bundle
node scripts/hii-bar-build.mjs --release  # release build + fresh staged CLI
node scripts/hii-bar-build.mjs --test     # swift test
node scripts/hii-bar-build.mjs --run      # build, bundle, launch
npm run bar:build                         # same as the first form
npm run bar:check                         # swift test
```

Output: `macos/.build/HII Bar.app`. Copy it to `/Applications` to install.

The script assembles the bundle itself because SwiftPM emits a bare executable
and an `LSUIElement` agent app needs a real `Contents/Info.plist`. **No Xcode
project is required.**

### Bundled CLI

The build stages `target/release/hii` into `Contents/Resources/hii` using the
same `stageCli` helper as `scripts/hii-stage-cli.mjs`. `CLILocator` checks that
bundled copy before any developer path, so a copied app works on a machine that
never built this repository. Resolution order:

1. `$HII_CLI_BIN`
2. `<App>/Contents/Resources/hii`
3. `~/bin/hii`
4. `~/hii/target/release/hii`
5. `/opt/homebrew/bin/hii`

## Using it

- Tap **⌘ SHIFT** from any app. Ordinary shortcuts such as `⌘⇧4` cancel the
  modifier gesture and continue normally. Because modifier-only global gestures
  need macOS Accessibility permission, use the menu bar's **Enable ⌘ SHIFT…**
  item once, then relaunch HII Bar if macOS requests it. **⌃⌥H** remains a
  permission-free fallback. HII never takes `⌘ Space` from Spotlight.
- A translucent text capsule appears beside the pointer. Type and press Return.
- The response expands immediately under the input and streams in place.
- Plain text is local, read-only chat using HII's default fast local model and
  skips the workspace agent loop for latency.
- The same composer accepts `/do`, `/plan`, `/browse`, `/see`, and `/show` to
  enter HII's governed modes. `/help` shows the grammar and `/clear` starts a
  new transcript. Write-capable modes pause at an inline Allow/Cancel boundary.
- Escape dismisses the surface. While a run is active, Escape also stops it.
- Right-click the menu bar icon for the workspace picker and Quit.

## State

Everything this app persists lives under `~/.hii/bar/`, a new directory chosen
so it cannot collide with `~/.hii/chat`, `~/.hii/conversations`, or
`~/.hii/runs`.

Plain chat does not transmit current-app context and the bar takes no
screenshots. When context observation is enabled, explicit governed commands
can receive the bounded app/window context captured before the panel activates.

## Start at login

`launchd/ai.hii.bar.plist` is provided but **not installed by the build**.
Opt in explicitly:

```bash
bash scripts/hii-bar-install-login-item.sh
bash scripts/hii-bar-install-login-item.sh --remove
```
