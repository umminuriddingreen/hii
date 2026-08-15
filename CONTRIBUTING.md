# Contributing to HII

Thanks for looking. HII is the user-owned context and control plane for
human–agent computing — see [`docs/thesis.md`](docs/thesis.md) for what that
means and, just as importantly, what HII deliberately does not try to be.

## Before you write code

**Know which license tier your change lands in.** This repository is
dual-tiered, and it is not negotiable per-PR:

| Tier | Where | License |
| --- | --- | --- |
| Core runtime, CLI, surfaces | `aii/`, `cli/`, `native-runner/`, `src-tauri/`, `src/`, `app/`, `lib/`, `server/`, `scripts/` | Business Source License 1.1 → Apache-2.0 on the Change Date |
| Protocol, schemas, skills, extensions | `protocol/`, `extensions/hii-stream-mcp/`, `skills/`, `aii/skills/` | Apache-2.0 |
| Vendored third parties | `external/` | upstream terms — **do not patch here; send it upstream** |

Full map in [`NOTICE`](NOTICE). If a change spans tiers, say so in the PR.

**Sign the CLA.** Substantial contributions require agreement to
[`CLA.md`](CLA.md) — a checkbox in the pull request template until an automated
service is wired up. You keep ownership of your work; the Project needs the
right to relicense across the tiers above and honor the BSL conversion.

**Open an issue first for anything structural.** Especially: new capabilities,
changes to the Operational Graph or receipt format, new agent substrates, or
anything that touches authority and permissions. Those are architecture
decisions, and `docs/decisions/` is where they get recorded.

**Do not build generic activity capture.** OS- and vendor-level activity capture
is a commodity input now. HII ingests it as a *sensor*; it does not compete with
it. A PR that adds first-party "record everything I do" capture will be
declined — a PR that adds a clean sensor adapter is welcome. See
[`docs/thesis.md`](docs/thesis.md).

## Setup

```sh
npm install
cp .env.example .env      # secrets are reference-only; never commit real values
npm run dev               # Next.js surface on 127.0.0.1
```

The Rust workspace (`cli/`, `native-runner/`) builds separately:

```sh
cargo build --workspace
```

## Checks

Run the fast gate before pushing; it is what CI runs first.

```sh
npm run ci:fast           # secret scan + typecheck + vitest + cargo fmt/test/clippy
```

Broader gates, in increasing cost:

```sh
npm run test              # vitest only
npm run cli:check         # cargo fmt --check, test, clippy -D warnings
npm run ci:product        # capability, SDK, skill, knowledge, workspace smokes
npm run ci:full           # ci:fast + cli:build + ci:product + build
```

Product areas have targeted smokes — `npm run hii:sdk:check`,
`hii:skills:check`, `hii:workspace:check`, and so on. Run the ones your change
touches rather than waiting on `ci:full`.

## Pull requests

- One concern per PR. A refactor and a behavior change are two PRs.
- Include the verification you actually ran, with output. "Should work" is not
  verification.
- Match surrounding code: existing naming, comment density, and idiom beat
  personal style.
- New runtime state goes through HII's own paths (capabilities, receipts,
  config) rather than a parallel mechanism.
- Secrets stay reference-only. `npm run security:secrets` must pass.

## Reporting security issues

Do not open a public issue. See [`SECURITY.md`](SECURITY.md).

## Using the HII name

The license covers the code; it does not cover the name. Forks must be named
something else. See [`TRADEMARK.md`](TRADEMARK.md).
