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

---

# Design QA — Canvas-native HII landing page

## Evidence

- Target visual system: `public/marketing/hii-workspace-live.png` — 1280 × 720, intrinsic 1×. Supporting product references: `public/marketing/hii-command-palette-live.png` and `public/marketing/hii-run-receipt-live.png`.
- Desktop implementation: `/mnt/c/Users/ummin/.codex/visualizations/2026/09/18/01a0b47f-e2ab-77c3-b92e-557842776861/hii-landing/desktop-final.png` — 1762 × 948 CSS pixels, device scale 1.
- Tablet implementation: `/mnt/c/Users/ummin/.codex/visualizations/2026/09/18/01a0b47f-e2ab-77c3-b92e-557842776861/hii-landing/tablet-hero.png` — 768 × 1024 CSS pixels, device scale 1.
- Mobile implementation: `/mnt/c/Users/ummin/.codex/visualizations/2026/09/18/01a0b47f-e2ab-77c3-b92e-557842776861/hii-landing/mobile-final.png` — 390 × 844 CSS pixels, device scale 1.
- Mobile account overlay: `/mnt/c/Users/ummin/.codex/visualizations/2026/09/18/01a0b47f-e2ab-77c3-b92e-557842776861/hii-landing/mobile-auth.png` — 390 × 844 CSS pixels, device scale 1.
- State: unauthenticated `/?site=1`, light color scheme, reduced motion enabled for mobile; local-owner behavior also checked separately on loopback.

The target and desktop implementation were inspected together at original detail. This is a visual-system translation, not a pixel-identical clone: the workspace reference supplies the palette, field grid, translucent object windows, monospace metadata, compact status accents, and spatial proportions used by the marketing surface.

## Interaction and runtime checks

- Primary `try the canvas` action remains a direct link to `/`.
- Existing local-owner session correctly enters the canvas from account CTAs.
- Fresh unauthenticated `create your HII` opens the signup dialog; focus lands on the name field, Tab remains in the dialog, and Escape closes it.
- Desktop, tablet, and mobile implementation widths equal their scroll widths; no horizontal overflow was found.
- Product images loaded at all checked widths.
- Browser console contained development/HMR information only; page errors were empty on the intended origin.
- Axe 4.12.1: 39 passes, 0 incomplete, 0 violations after the final contrast adjustment.

## Fidelity surfaces

1. Layout and geometry: passed. The desktop hero uses the reference workspace as the dominant spatial object; tablet and mobile collapse to a safe single-column reading order.
2. Typography and hierarchy: passed. Display copy remains primary while monospace labels, status text, and captions match the workspace shell.
3. Color and surfaces: passed. Off-white canvas, translucent panels, restrained blue/green status accents, and light authority surfaces replace the dark campaign treatment.
4. Product truth and media: passed. Live workspace, command palette, and run receipt imagery render in context with descriptive alt text; ASCII and dark campaign art are absent from this page.
5. Interaction and accessibility: passed. Interactive targets are at least 44px, keyboard focus is visible, modal focus handling remains intact, reduced motion is supported, and automated contrast checks pass.

## Comparison history

- Pass 1: layout, media, responsive stacking, modal behavior, and overflow passed. Automated accessibility found three muted-text instances at 4.48:1 against the 4.5:1 threshold.
- Pass 2: increased the shared muted-text token from 58% to 62% opacity. Re-ran the audit with 0 violations and recaptured final desktop/mobile states.

## Release note

The production application build passes. `npm run deploy` did not upload because the already-modified public worker fails in its existing Wasm build step: `failed to generate catch wrappers` / `externref table required for catch wrappers`. No worker files were changed as part of this design work. The live URL still returns HTTP 200 but remains on the previous dark build; that state is captured at `/mnt/c/Users/ummin/.codex/visualizations/2026/09/18/01a0b47f-e2ab-77c3-b92e-557842776861/hii-landing/live-before-release.png`.

Final result: passed
