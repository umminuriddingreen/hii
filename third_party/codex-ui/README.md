# Codex UI attribution

HII selectively adapts terminal display-width behavior from OpenAI Codex:

- Upstream: `codex-rs/tui/src/width.rs`
- Revision: `86a54b051c08f34f373c507ae16a91915ab08700`
- Local adaptation: `cli/src/codex_ui.rs`
- Used by: HII's single-row composer window and cursor placement.

The upstream implementation's Unicode cell-width handling is preserved for
wide characters and halfwidth Japanese sound marks. The composer and footer
remain HII-owned. Codex's runtime, protocol, app server, and harness are not
included. See the accompanying `LICENSE` and `NOTICE`.
