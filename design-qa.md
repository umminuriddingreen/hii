# HII terminal and search fast-path design QA

- Supplied problem state: `/var/folders/hx/fjz8vhld0q9gmwxpbm3knjw40000gn/T/TemporaryItems/NSIRD_screencaptureui_SB4eR2/Screenshot 2026-09-02 at 1.53.47 AM.png`
- Normalized problem state: `/tmp/hii-pty-ref/reference.png`
- Installed-app baseline capture: `/var/folders/hx/fjz8vhld0q9gmwxpbm3knjw40000gn/T/codex-shot-2026-09-02_02-06-32.png`
- Target runtime: installed macOS HII app, persistent workspace

## Visual intent

The supplied screenshot is the state to remove: a large white agent card, a
secondary Commands/Settings panel, and a staged status sentence that makes a
simple model interaction feel slow. The requested replacement is a real,
compact PTY terminal with no visible header. A separate 42 px search field opens
from Command-T and disappears when its text becomes a live Google-results
browser object on the canvas.

## Implemented surfaces

- Command-K opens the canonical persistent PTY in a centered 760 x 260 px maximum surface.
- The PTY has raw xterm streaming, a blinking cursor, no prompt-card context compile, and no visible title bar.
- Command-K works ahead of field-focus filtering and closes the compact PTY when it owns focus.
- Command-T opens a focused 42 px Google search field.
- Return replaces the search field with the existing live native browser object at canvas center.
- Command-question-mark opens the complete keyboard and slash-command reference.
- The toolbar exposes Quick terminal and Web search with their keyboard shortcuts.

## Functional verification

- 35 focused interaction tests passed across terminal, command bar, browser, and web-access contracts.
- Full TypeScript check passed.
- Desktop Next build and optimized Tauri build passed.
- `/Applications/HII.app` was replaced, relaunched, and passed strict deep codesign verification.
- Installed app process settled near 178 MB RSS and roughly 1 percent CPU during the verification sample.

## Findings

- [P1] The final compact PTY and Command-T states were not captured from the installed app.
  The installed canvas and signed bundle were captured, but injected macOS
  Command-K events did not reach the WebView during automated capture even
  after the shortcut was made independent of field focus. The focused source
  contracts pass, but the Product Design gate requires a same-state installed
  screenshot before visual fidelity can be called passed.

## Required next visual proof

1. Press Command-K in the installed HII app and capture the compact black PTY.
2. Press Command-T and capture the small search field.
3. Search a phrase and confirm the field is replaced by a live Google-results browser object.

final result: blocked
