# HII runtime contract

HII is one product and one runtime. The former AII modules are consolidated in `runtime/` inside HII.

The Rust CLI owns execution authority. Web, desktop, and native adapters consume the same capabilities, model routing, context, work records, and receipts. Internal module boundaries organize implementation; they do not define separate products or registries.

Durable state remains under `~/.hii`. Canonical capabilities are in `runtime/capabilities`; the daemon, model lifecycle, skills, and Codex schemas are adjacent modules under the same runtime. Operate these through `hii` commands.

Existing installed releases retain their versioned resource paths until upgraded. No user database or model cache is renamed by this source migration.
