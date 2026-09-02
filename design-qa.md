# HII first-run terminal design QA

- Source visual truth: `/Users/ummi/Desktop/Screenshot 2026-09-01 at 8.01.32 PM.png`
- Normalized source used for inspection: `/tmp/hii-login-ref.yeaGkD/reference.png`
- Source pixels: 2186 x 1354
- Density normalization: source is treated as a 2x macOS capture, targeting 1093 x 677 CSS px at device scale factor 2
- Implementation screenshot: unavailable
- State: new HII user; centered first-run native PTY terminal

**Full-view comparison evidence**

The source was opened and inspected. The implementation compiled for web and
desktop, was bundled, signed, installed, and launched from `/Applications/HII.app`.
The required in-app browser was unavailable (`agent.browsers.list()` returned no
browser instances), so no browser-rendered implementation screenshot could be
captured at the matching viewport.

**Focused region comparison evidence**

Blocked for the same reason. The critical regions are the HII ASCII mark,
terminal frame proportions, xterm output, login commands, and live caret.

**Findings**

- [P1] Rendered fidelity cannot be verified.
  Location: first-run terminal at the new-user state.
  Evidence: source image is available, but no implementation screenshot exists.
  Impact: typography, spacing, scale, and viewport placement cannot be judged
  against the supplied reference.
  Fix: open the installed HII app after clearing
  `hii.onboarding.completed.v1`, or open the local web preview with
  `?first-run=1`; capture at 1093 x 677 CSS px with device scale factor 2, and
  compare the two images together.

**Required fidelity surfaces**

- Fonts and typography: code uses SF Mono-compatible fallbacks; rendered match blocked.
- Spacing and layout rhythm: centered responsive frame implemented; rendered match blocked.
- Colors and visual tokens: black xterm terminal, white canvas, gray hierarchy, and green commands implemented; rendered match blocked.
- Image quality and asset fidelity: no raster assets are substituted; the requested logo is code-rendered ASCII text; rendered match blocked.
- Copy and content: HII-specific welcome, `/login codex`, `/providers`, `/help`, and the local-authority boundary are present in the real terminal buffer.

**Comparison history**

- Initial pass: blocked before implementation capture because no browser instance was available.
- Functional revision: the desktop simulation was replaced with the persistent
  `NodeFrame` + `ShellTerminal` + Tauri PTY path; no visual fixes were inferred
  without a rendered comparison.

**Implementation checklist**

- Capture the installed app at the source viewport and first-run state.
- Compare source and implementation in one combined visual input.
- Correct any P1/P2 typography, proportion, or spacing drift.
- Verify `/providers`, `/login codex`, shell input, resize, move, and terminal replay in the installed app.
- Verify microphone permission and one final speech transcript in the installed WebView.

final result: blocked
