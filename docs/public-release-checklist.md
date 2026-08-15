# Public Release Checklist

The repository is **private**. The IP structure now exists so that flipping it
public is a checklist rather than a scramble. Nothing here has been executed.

Run top to bottom. Items marked **BLOCKER** must be closed before the flip.

## 1. Legal

- [ ] **BLOCKER — Counsel reviews the BSL Additional Use Grant** in `LICENSE`.
      The draft grant is the single most consequential paragraph in the repo; it
      defines what a company may do without paying, and it is hard to tighten
      after publication.
- [ ] **BLOCKER — Counsel reviews `CLA.md`.** Adapted from the Apache ICLA, not
      executed legal advice.
- [ ] **BLOCKER — Decide the Licensor.** `LICENSE`, `NOTICE`, `TRADEMARK.md`,
      and `CLA.md` all currently name *Ummi Nuriddin Green* personally. If an
      entity is formed, assign the copyright to it and update all four before
      publishing — a post-publication assignment is messier.
- [ ] **BLOCKER — Set the Change Date.** `LICENSE` says `TBD — set on public
      release`. It is four years from the first publication date; compute it at
      flip time and write the literal date.
- [ ] Confirm the contact address in `LICENSE`, `SECURITY.md`, `TRADEMARK.md`,
      and `CLA.md` is one you want public and monitored. `ug7@njit.edu` is a
      university address — a project or entity address is probably better.

## 2. Trademark

- [ ] File for federal registration of **HII** and **Human Information
      Interface** (USPTO, likely Class 9 and Class 42). `TRADEMARK.md` asserts
      common-law rights; registration is what makes them enforceable at scale.
- [ ] Confirm the marks clear a knockout search first — "HII" is short, and a
      conflict is cheaper to find now than after launch.
- [ ] Secure the matching npm scope, crates.io name, GitHub org, and social
      handles before the repo is discoverable.

## 3. `external/` — mostly already solved

Good news, confirmed 2026-08-13: `/external/`, `/browser/`, and `/social/` are
gitignored and **zero files under them are tracked** (`git ls-files external |
wc -l` → 0). The eleven vendored repos on disk — including two GPL-3.0 Chromium
forks — are never distributed with this repository. `NOTICE` §3 documents them
for local-checkout readers only.

Remaining:

- [ ] Confirm nothing under those paths has been committed historically:
      `git log --all --oneline -- external/ browser/ social/` should be empty.
- [ ] `external/agent-harness-benchmark/` and `external/mac_computer_use/` have
      **no license file on disk**. Establish their provenance before any of
      their code is copied into the first-party tree. (`mac_computer_use` looks
      like Anthropic's computer-use demo — confirm and record the license.)
- [ ] Add a `scripts/` fetcher, or document in the README how a contributor
      obtains `external/` when a workflow needs it, since a fresh clone will not
      have it.

## 4. Secrets — **BLOCKER**

- [ ] `npm run security:secrets` passes on the working tree.
- [ ] Scan the **full history**, not just HEAD: `gitleaks detect --no-git=false`
      or `trufflehog git file://.`. Anything found means rotate the credential
      *and* rewrite history before the flip.
- [ ] Confirm `.env`, `.hii/`, `.hii-run-context`, `artifacts/`, and `output/`
      are gitignored and were never committed.
- [ ] Review `config/` and `launchd/` for machine-specific paths, hostnames,
      tokens, or personal identifiers.
- [ ] Grep for `ug7@njit.edu`, home directory paths (`/Users/ummi`), and
      internal hostnames across tracked files.

## 5. Repository presentation

- [ ] Rewrite `README.md` for a first-time reader: what HII is (per
      `docs/thesis.md`), what it is not, install, the license tiers, and a
      pointer to `protocol/`.
- [ ] Verify GitHub detects the licenses — it should show BSL at root and
      Apache-2.0 on the subdirectories that carry their own `LICENSE`.
- [ ] `CONTRIBUTING.md`, `SECURITY.md`, `TRADEMARK.md`, `CLA.md`, and the PR
      template are all linked and reachable.
- [ ] Enable GitHub Security Advisories and Dependabot alerts.
- [ ] Enable branch protection on `main` before external PRs can arrive.
- [ ] Consider moving the CLA checkbox to CLA Assistant once there is real
      inbound volume.

## 6. Funding

- [ ] **Enable GitHub Sponsors on the account** — this cannot be done from the
      repo; `.github/FUNDING.yml` already points at
      `github.com/sponsors/umminuriddingreen` and will 404 until it is enabled.
- [ ] Supply live Stripe keys (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) and
      register the production webhook endpoint at `/api/support/webhook`.
- [ ] Confirm the custom URL in `FUNDING.yml` resolves to the deployed
      `/support` page.
- [ ] Sanity-check the donation disclaimer on `/support` against how you
      actually intend to characterize the money.

## 7. Final

- [ ] `npm run ci:full` green.
- [ ] `cargo check --workspace` green.
- [ ] Tag the release commit — the Change Date is anchored to publication, so the
      commit that goes public should be identifiable forever.
- [ ] Flip visibility.
