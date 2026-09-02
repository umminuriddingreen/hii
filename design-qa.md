# HII web and macOS parity design QA

- Canonical macOS reference: `/Users/ummi/Desktop/Screenshot 2026-09-02 at 1.17.31 AM.png`
- Before-state web reference: `/Users/ummi/Desktop/Screenshot 2026-09-02 at 1.17.24 AM.png`
- Reference pixels: macOS 2890 x 1938; web 2640 x 1944
- Target state: authenticated desktop web canvas at a fine-pointer viewport
- Implementation screenshot: unavailable

## Comparison evidence

The two supplied screenshots were normalized and inspected together. The visible
difference was structural: the web surface added an account header and always-on
canvas toolbar, while the macOS app used an adaptive, chrome-free canvas.

The implementation now uses the same canonical `HiiRoot` in adaptive-chrome
mode. Fine-pointer desktop web hides the account header and canvas toolbar;
opening the command surface reveals the toolbar. Touch viewports retain visible
controls.

A rendered after-state comparison is blocked. The in-app browser and Chrome
browser-runtime targets both reported that no browser was available. The
OS-level Chrome fallback could not reliably isolate the newly opened HII window
from the user's existing Chrome windows, so capture was stopped without using
or changing existing browser content.

## Functional verification

- Desktop web: Command/Control-1 toggles account and workspace controls.
- Desktop web: Command-Space or Option-Space opens trusted HII Remote handoff.
- Touch web: visible account and canvas controls remain present.
- Existing account-canvas note, text, draw, import, zoom, undo, redo, delete,
  canvas-manager, sharing, and persistence paths remain on canonical `HiiRoot`.
- Focused interaction contract: 26 tests passed.
- Type check: passed.
- Production web build: passed.

## Findings

- [P1] Final rendered fidelity is not verified.
  Location: authenticated desktop web canvas.
  Evidence: both integrated browser targets were unavailable and the safe
  OS-level fallback could not isolate the HII preview window.
  Impact: the structural parity is code- and test-verified, but exact rendered
  spacing and viewport fidelity cannot yet be claimed.
  Fix: capture the authenticated local preview at the same viewport as the
  macOS reference and compare both images in one visual input.

## Required fidelity surfaces

- Canvas and typography: shared canonical `HiiRoot`; rendered match blocked.
- Persistent chrome: removed for fine-pointer desktop web.
- Command chrome: available on demand; visible on touch.
- Native authority: web routes terminal and assistant authority to trusted HII
  Remote rather than pretending a browser has local Tauri capabilities.

final result: blocked
