# Selective Codex terminal UI adoption

User direction: take genuinely useful Codex UI code, retaining HII execution and persistence.

Upstream inspected: https://github.com/openai/codex at `86a54b051c08f34f373c507ae16a91915ab08700`; local checkout `/Users/ummi/codex-ui-upstream`.

Adapted `codex-rs/tui/src/width.rs` into `cli/src/codex_ui.rs`, with Apache-2.0 license and upstream NOTICE in `third_party/codex-ui`. HII now uses terminal-cell width for horizontally scrolling input and live cursor placement, including CJK and Japanese halfwidth sound marks. Removed the minimum eight-column input width that could exceed a narrow terminal. Added quiet send/history/command hints, hidden on narrow terminals.

This is a selective source adaptation, not a full Codex fork or a replacement renderer. Codex core, app-server, protocol, login, sandboxing, and agent harness are not dependencies. HII owns the composer, tools, model routing, persistence, compaction, and stream. No GitHub fork was published.

Validation: offline CLI build and focused renderer/width tests; exact results in the local action receipt. No broad regression suite or model benchmark. Installed CLI and interactive visual behavior require separate release proof.
