# HII Fingerprint Test launch brief

Date: 2026-07-30

Status: pre-production. Do not publish until the live acceptance test, cohort
terms, application destination, and public-release boundary are complete.

This brief combines primary tester evidence from Arry, two read-only Claude
Opus 5 reviews, and current HII product proof. The latest collaboration used
`claude-opus-5` session `a1766923-d8fa-4d1d-9d4f-06af13a41825`.
Opus proposed the mechanic. HII's implementation and receipts decide every
claim.

## Strategic truth

Most AI interfaces show the answer but make the operative context hard to
inspect. HII's sharpest visible difference is simpler:

> What you point at is part of the contract.

A person can change an image region, PDF range, design frame/layers, drawing
view/layers, media range, or 3D view before approval. HII updates the pending
intent and run, clears the stale manifest, and computes a new approval
fingerprint. Queued and completed runs remain immutable.

Arry's first understanding—“a quicker way to access their work”—is the entry
point. The governed context and receipt are the retained value.

## Flagship clip: The Fingerprint Test

This clip proves one mechanic only. It does not tour HII or execute a run.
Record one continuous take with native canvas pan/zoom and no edits, speed
ramps, cursor effects, or simulated state.

Starting state:

- One calm named Scene.
- One imported image with a visible selected region.
- One imported design source with a named frame and three layers.
- One proposed run using those two objects plus a PDF page range.
- Approval manifest visible with `3/3 executable`, human-focus pills, source
  identity, read/write/network boundaries, installed model, step budget, and a
  legible fingerprint.
- Real HII-managed sources and hashes. No placeholder paths.

| Time | Real interaction | Burned-in caption |
| --- | --- | --- |
| 0–3s | Hold image region and approval fingerprint together | — |
| 3–8s | Press `focus region`; draw a visibly different region | `Change the focus.` |
| 8–13s | Hold on `focus refreshed`, `fingerprinting…`, then the changed fingerprint | `The approval changes.` |
| 13–19s | Pan to the design source; remove one layer name and press `use selection` | — |
| 19–24s | Hold on the second refreshed fingerprint | `What you point at is the contract.` |
| 24–30s | Pull back to the named Scene and its three source objects | `For makers who sign off on the work.` |
| 30–38s | Pan through focus, provenance, read/write boundary, `Network: none`, model, and step budget | `Named context. Named boundary.` |
| 38–42s | Hover `Approve bounded run`; do not click | `Nothing ran before approval.` |
| 42–45s | End card | `HII · Intent in. Receipt out.` |

Reject the take unless:

1. Both fingerprint changes are readable at phone size.
2. The changes come from two distinct anchor types.
3. `focus refreshed` and the recomputed manifest are real UI state.
4. The approval fingerprint changes before approval.
5. No source, path, user data, or network claim is fabricated.
6. The CTA is a paid cohort or waitlist, never a nonexistent public download.

Implementation acceptance passed locally on 2026-07-30 in
`sub-asset-anchor-proof`. The Scene used the real content hashes for
`public/brand/hii-wordmark.svg` and `app/icon.svg`. Removing one named design
layer changed the pending fingerprint from
`4b1ff8ff1c92f2f0625de14576440eb326898256bd7affa01c2c21a16d244f8b` to
`0ff8dca494c59608b85db79bf7f380772d86fbfd6d34d87a48c54da5a94a5464`
while the manifest stayed `3/3 executable`, approval stayed available, no run
started, and no browser error was recorded. This validates the mechanic, not a
finished public take.

The full context → approval → run → artifact → receipt film remains a separate
follow-up in `hii-x-launch-kit-opus5.md`. Its real local-model latency may use
one visible, accurately labeled elapsed-time jump. The Fingerprint Test must
not borrow an artifact or receipt it did not create.

## Launch post

> I changed the region selected on an image and the AI run's approval
> fingerprint changed before anything executed.
>
> That is HII: what you point at is part of the contract.
>
> Select the context. Read the boundary. Approve—or do not.
>
> One continuous take, 45 seconds. HII on Mac. ↓

## Eight-post thread

**1/** AI tools usually show the answer. The operative context is harder to
inspect, so accountable people re-check the work themselves.

**2/** In HII, “select context” is literal. Choose a PDF page range, image
region, design frame and layers, drawing view, media range, or 3D view—not just
the whole file.

**3/** Change that focus before approval and the manifest fingerprint changes.
The context is load-bearing, not decoration. `[Fingerprint Test clip]`

**4/** Imported local sources are content-hashed. Selected assets are checked
again and staged read-only inside the approved run workspace.

**5/** Before execution, one card names context, provenance, focus, read/write
scope, network use, installed model, and step budget. Then a person approves.

**6/** A completed run returns an editable receipt-listed text or code artifact,
checks, and a human-readable receipt. The checks prove what ran; they do not
guarantee the content is correct.

**7/** A successful trace may become a capability draft. It is not executable
until an operator reviews and registers it.

**8/** HII is early: no public notarized release, onboarding is not yet proven
with first-time users, and dense canvases need more organization. The first
five participants will be paid and visibly credited for finding those
failures. `[one application link]`

## Arry's four questions

Every public surface should answer these without a feature wall:

| Question | Honest answer |
| --- | --- |
| Who is it for? | Independent multidisciplinary makers on Mac whose name is on the deliverable. |
| How many custom solutions can it hold? | Saved capabilities live locally; no tested ceiling is claimed yet. Capacity is a cohort test. |
| What does HII avoid? | Hidden context expansion, unbounded execution, opaque network use, and automatic capability promotion. |
| What happens after adoption? | Verified work becomes durable project context and, after review, reusable capability. |

One CTA:

> **Five paid seats in HII's first cohort. Bring real work. Keep what you make.
> Receive permanent credit for the version you shape. `[one link]`**

Do not publish the CTA until rate, dates, expected hours, consent terms,
removal contact, and the funded budget are explicit.

## First Five cohort

Proposed composition:

- one architect;
- one graphic or brand designer;
- one creative technologist;
- one fabricator;
- one producer, project manager, or technical editor.

Run for six weeks on real accountable work. Recruit deliberately through Black
creative networks and Black-led studios while keeping the application open.
Pay participants real money, feature their work only with per-asset written
approval, and credit them permanently in release notes and a HII `Built with`
Scene. This is community product development, not demographic marketing.

Required evidence from each participant:

1. An unassisted first-session recording.
2. One real shipped artifact and its HII receipt.
3. A failure log for onboarding, dense-canvas organization, and media
   selection.
4. One reviewed capability draft.
5. Their own candid public assessment, including the right to say HII failed.

## Claim boundary

Do not say:

- fully autonomous, works while you sleep, safe, secure, or “it just handles
  it”;
- private or nothing ever leaves the Mac;
- replaces Figma, Miro, Freeform, Cursor, Claude, or an IDE;
- audit-ready, correct, reproducible, no hallucinations, or independently
  verified;
- unlimited capabilities, works with every tool, zero setup, or available now;
- any desktop-window-management claim while AeroSpace is offline;
- contact-sheet item selection before it is implemented;
- any speed multiplier or prediction of virality.

Use countable product facts instead. Keep `Intent in. Receipt out.` as the
sign-off, not the cold-open headline.
