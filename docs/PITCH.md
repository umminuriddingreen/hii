# HII — YC pitch

**Status:** pitch narrative, pre-external-traction
**Founder:** Ummi Nuriddin Green
**Date:** 2026-07-29
**Companion docs:** `LAUNCH_AND_MONETIZATION.md` (offer, economics, gates) · `HII_AII_MASTER_CONTEXT.md` (architecture authority) · `hii-brand-dna-v0.1.md` (voice, UX laws) · `RELEASE_READINESS.md` (ship blockers)

---

## One-liner

**HII is the local-first workspace that turns your own information into verified agent work you can inspect.**

Alternate, for a technical audience:

> HII is a governed context and proof layer for coding agents. It sits on your Mac, between your files and whichever agent you already use, and it makes every run source-linked, bounded, and receipted.

---

## The problem

People who work with agents daily have three unsolved problems, and none of them are model quality:

1. **Context is scattered and re-fed by hand.** The work lives across folders, notes, repos, and past agent chats. Every session starts by re-explaining.
2. **Authority is all-or-nothing.** Agents get broad access or none. There is no separation between *reading* your context, *executing* work, and *publishing or spending*.
3. **Output is unverifiable.** A confident summary and a correct result look identical. There is no artifact that proves what an agent actually did.

The result is that agent work does not compound. Every run is disposable, so nothing built with an agent becomes an asset.

## The insight

The durable layer is not the agent. It is the **information substrate and the proof** around it.

Models are converging and commoditizing on a quarterly cycle. What does not commoditize is a trustworthy, user-owned record of *what context was approved, what was done with it, and how it was verified*. That record outlives any vendor and any chat.

So HII deliberately does not compete on agent quality. It is **agent-agnostic on purpose** — Codex, Claude Code, and local Ollama models all plug in. HII owns the context and the receipt.

## The product

One loop, and the whole product is judged by it:

```
human intent
 → approved, source-linked context
 → bounded work
 → governed capability execution
 → logs, artifacts, tests
 → verification
 → inspectable receipt
 → durable project memory
 → reusable capability
```

What a user actually does:

1. Bring in a folder, file, note, link, or local project.
2. State one outcome.
3. Approve exactly which information and permissions the agent may use.
4. Watch bounded work happen on a spatial canvas — terminal, chat, browser, files, and live system state as objects side by side.
5. Review the artifact, the checks, and the receipt.
6. Resume from the same information later.

**The activation event is not signup. It is a first verified receipt.**

## The wedge competitors don't own

| | Codex | Claude | HII |
|---|---|---|---|
| Agent-agnostic | no | no | **yes** |
| Local-first, user-owned context | no | no | **yes** |
| Separated authority (read / run / publish / spend) | partial | partial | **yes** |
| Inspectable receipt per run | no | no | **yes** |
| Verified work becomes a reusable capability | no | no | **yes** |

Codex is a command center for software agents. Claude connects a strong assistant to projects and cloud tools. Both are vendor-bound by design — that's their business. HII's position is the one neither can take: the neutral, local, governed substrate underneath all of them.

The moat is not "more agents." It is that **a verified result becomes durable memory and a reusable capability** — so the workspace gets more valuable with use, and the value is portable across model vendors.

## Why now

- Three credible agent runtimes (Codex, Claude Code, local Ollama) now exist on the same Mac, so "agent-agnostic" is a real user need rather than a hypothetical.
- Apple Silicon runs useful local models, making local-first a performance choice and not just a privacy one.
- Agent output volume has outrun anyone's ability to review it. Verification is becoming the bottleneck.

## Proof: what is actually built

This is a working system, not a prototype:

- **502 files, ~188K lines** of shipped implementation on the active branch since 2026-06-28.
- **SvelteKit app + Rust CLI + local daemon (`hiid`)**, with MCP and ACP stdio servers.
- **Spatial workspace** — terminal, chat, browser, explorer, documents, CAD/3D, and live system context as canvas objects.
- **37 registered capabilities**, governed by an explicit permission tier per action.
- **Receipt discipline that already works**: 87 agent-action receipts on disk, each citing intent, commands, files, capabilities, verification checks, and proof paths.
- **Real CI**: 83 Vitest tests, 45 Rust tests, strict clippy, `svelte-check` clean, plus a local-model evaluation suite that runs live model cases in isolated workspaces.
- **74 end-to-end CLI runs** with receipts.

Verification is not a slogan here — it is the thing the codebase spends most of its rigor on.

## Traction — stated honestly

**Zero external users to date.** All 74 receipted runs are the founder's own machine on the founder's own project.

The founder-beta campaign (5 design partners, 3 × $500 pilots) was planned for Jul 20 – Aug 2, 2026 and did **not** launch. The blockers were not product blockers; they were unfinished distribution prerequisites: Apple Developer enrollment and code signing, host + DNS, and a payment link. The end-to-end activation path itself **passed live** on 2026-07-19 for both the Codex and Claude Code paths on a clean non-git folder.

The honest read: **the product works and cannot yet be downloaded by a stranger.** That is the single gap between today and first revenue, and it is the next milestone.

## Market and first customer

First customer is a **Mac-based independent operator** already using Codex, Claude Code, or Ollama, with valuable work split across files, notes, repos, and agent chats.

They qualify when all four hold:

- they repeat an information-heavy workflow weekly;
- the output is worth ≥ $500 when correct;
- lost context, unclear permissions, or unverifiable output costs them real time;
- they can bring one real task to a guided activation within seven days.

Beachhead is founders, designers, researchers, and technical creative operators. Expansion is teams that need shared, governed context with an audit trail — a requirement that gets sharper as agent use becomes regulated.

## Business model

An offer ladder where each rung must be earned by evidence from the rung below:

| Tier | Price | Gate to launch it |
|---|---|---|
| Local beta | free | — |
| **Founder activation** | **$500 one-time** | now |
| HII Pro | ~$39/mo | ≥10 beta users with 2 receipts in separate weeks, ≥5 requesting an ongoing responsibility |
| Team implementation | $2.5K–$10K | 3 workflows repeated across users, stable permission boundaries |

Activation unit economics: $20 processing + $200 delivery + $30 support/risk → **~$250 contribution, 50% margin**, with a hard ceiling of 2 hours founder labor after the design call. Full refund if the agreed bounded workflow doesn't complete.

Discipline built into the model: Pro only launches if the subscription funds a responsibility HII actually performs — never to remove an artificial local limit.

## Metrics that matter

Primary: time from app open to first verified receipt · % of installs producing a receipt within 24h · % producing a second receipt within 7 days.

Launch gates: median first receipt **under 30 minutes**; **≥60%** of assisted users complete a second receipt within 7 days; **≥50%** contribution margin; zero critical permission, secret-handling, installer, or data-loss incidents.

## Risks, and what reduces them

| Risk | Reduction |
|---|---|
| Model vendors absorb the context layer | Agent-agnostic + local-first is the position they structurally can't copy; neutrality is the product |
| Local-first caps market vs. cloud | Beachhead genuinely wants local; team tier adds governed sharing later, not cloud dependence |
| Single-founder execution risk | Receipt-and-verification discipline is already automated; the system is built to be handed off |
| Verification is a hard sell until it's felt | Don't sell verification. Sell one completed valuable task; the receipt is what earns the second one |
| Scope sprawl (the live one) | Documented: one loop, one activation event, "anything that does not improve this loop is not in the pitch" |

## The ask and the next 30 days

**Milestone: five paid founder activations from strangers, each ending in a verified receipt.**

Build now:
1. Apple Developer enrollment + Developer ID certificate → notarized build. *(blocking everything)*
2. Domain + launch site live with exactly two CTAs: *Get the Mac beta* and *Build my first workflow*.
3. Notarized archive behind the download CTA.
4. Five manual paid activations, instrumented end to end.

Then: turn the most repeated activation into an in-product guided workflow, publish three consented redacted proof stories, and decide which recurring responsibility is worth paying for.

No paid acquisition until those five customers complete or churn.

---

## Team

**Ummi Nuriddin Green** — founder, sole engineer and designer. Built the entire system: SvelteKit app, Rust CLI, local daemon, capability governance, and receipt architecture. Operates a multi-agent development workflow (Codex + Claude Code + local models) with automated verification receipts — the practice the product is built to generalize.
