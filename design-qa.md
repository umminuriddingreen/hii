# HII Command-K bar design QA

- Source visual truth: `/Users/ummi/Desktop/Screenshot 2026-09-02 at 1.34.27 AM.png`
- Normalized source: `/tmp/hii-textbar-ref/reference-normalized.png`
- Installed implementation: `/var/folders/hx/fjz8vhld0q9gmwxpbm3knjw40000gn/T/codex-shot-2026-09-02_01-45-05.png`
- Normalized implementation: `/tmp/hii-textbar-ref/implementation-normalized.png`
- Combined comparison: `/tmp/hii-textbar-ref/comparison.png`
- Source pixels: 1404 x 786
- Implementation pixels: 3104 x 2144; installed HII window 1440 x 960 CSS px
- Comparison pixels: both views normalized to 1404 x 786
- State: installed macOS HII app, one selected canvas object, Command-K prompt idle

## Full-view comparison evidence

The combined comparison places the supplied reference beside the installed app.
The reference has a roughly 380 px-tall card containing context, five modes, an
instruction, and an error. The implementation keeps the same white, rounded,
near-cursor visual language but reduces the default Command-K surface to a
single 42 px input row. Canvas content remains visible around it.

## Focused region comparison evidence

The Command-K region is readable in the combined comparison without another
crop. The implementation preserves the ellipsis, text entry, microphone,
rounded border, and soft shadow while removing all default secondary chrome.
Response content opens directly below the bar only after a real model delta or
terminal state arrives.

## Functional verification

- Installed `/Applications/HII.app` opened the compact bar from Command-K.
- The ellipsis menu exposes Commands and Settings.
- Question mark opens the full keyboard command reference from the canvas.
- Settings changes Build, Plan, Browse, See, and Present mode.
- Tauri now forwards exact `assistant.stream.delta` content.
- The web bridge preserves leading whitespace in response deltas.
- Tool/status events do not pollute the direct model response.
- 29 focused tests passed, including three response-stream tests and four
  command-bar contract tests.
- TypeScript check passed.
- Focused Rust streaming test passed.
- Signed Tauri build, installation, relaunch, and codesign verification passed.

## Findings

- [P2] Commands and Settings expanded states were not captured from the installed app.
  Location: Command-K ellipsis menu and question-mark command reference.
  Evidence: their behavior and styles are covered by focused tests, but only the
  collapsed Command-K state was captured before input automation was stopped.
  Impact: default-state fidelity is verified; expanded-state visual polish still
  needs one human inspection.
  Fix: press `?`, then open `••• → Settings`, and inspect the two compact panels.

## Required fidelity surfaces

- Fonts and typography: compact 14 px input and 13 px streamed output match the native canvas hierarchy.
- Spacing and layout rhythm: default prompt reduced to one 42 px row with 28 px controls.
- Colors and visual tokens: existing HII white field, gray controls, faint border, and shadow retained.
- Image quality and asset fidelity: no new raster assets or approximated icons; existing Phosphor icons are used.
- Copy and content: `Ask HII…`, Commands, Settings, Direct model stream, modes, keyboard commands, and slash commands are present.

## Comparison history

- Initial reference: large persistent mode/context/error card obscured the canvas.
- Revision: default Command-K state reduced to the minimal prompt row; modes moved into Settings; keyboard and slash commands moved into Commands; actual model deltas render below the row.
- Post-fix evidence: installed-app screenshot and combined comparison confirm the compact default state.

final result: blocked
