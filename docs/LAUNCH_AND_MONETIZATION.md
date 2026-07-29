# HII launch and monetization contract

Status: founder-beta operating plan  
Product: HII for Apple Silicon Macs running macOS 13 or newer  
Activation event: a user completes one real task and can inspect its sources, changes, checks, and receipt

## The product we are launching

HII is the Human Information Interface: one local workspace where a person can bring information, give it an intention, work with the agent they already use, and inspect the result.

The launch surface is deliberately small:

1. Bring in a folder, file, note, link, or local project.
2. State one outcome.
3. Approve the information and permissions the agent may use.
4. Watch bounded work happen.
5. Review the artifact, checks, and receipt.
6. Resume from the same information later.

Anything that does not improve this loop is not part of the founder-beta pitch.

## Who it is for first

The first customer is a Mac-based independent operator who already uses Codex, Claude Code, or Ollama and has valuable work split across files, notes, repositories, and agent chats.

They qualify when all four are true:

- They repeat at least one information-heavy workflow every week.
- The output is worth at least $500 when it is correct.
- Lost context, unclear permissions, or unverifiable agent output currently costs them time.
- They can bring one real task to a guided activation within seven days.

Do not lead with “everyone.” Win founders, designers, researchers, and technical creative operators who already feel the coordination problem.

## The wedge competitors do not own

Codex is a command center for software agents. Claude connects a strong assistant to projects, extensions, and cloud tools. HeyClicky minimizes the distance between cursor and agent. Polsia sells autonomous business operation.

HII should not copy those products. Its durable wedge is the shared, governed information workspace:

- Agent-agnostic: the information and proof outlive any one model vendor or chat.
- Local-first: the workspace begins on the user’s Mac and transmits context deliberately.
- Spatial and inspectable: intent, sources, agent work, artifacts, and receipts remain visible together.
- Governed: reading context, executing work, publishing, spending, and deleting are separate authorities.
- Cumulative: a verified result becomes durable memory and a reusable capability.

The moat is not “more agents.” It is a trustworthy information substrate on which humans and agents can keep working.

## Offer ladder

### 1. HII local beta — free

Includes the Mac app, local workspace, knowledge, bounded agent runs, and receipts. Users bring their own supported agent account or local model.

Purpose: trust, distribution, and product learning. No credit card. No sale of user information.

### 2. Founder activation — $500 one time

Promise: “Bring one valuable task. We will configure HII around it and stay until the first verified result works.”

Includes:

- one 60-minute workflow-design session;
- hands-on Mac and agent setup;
- one working, bounded workflow;
- one inspected receipt and handoff;
- seven days of fixes for the agreed workflow.

Delivery must stay below two hours of live founder labor after the design call. If it repeatedly exceeds that limit, narrow the workflow or raise the price before selling more.

### 3. HII Pro — validate before selling

Candidate price: $39 per month.

Only launch after at least ten beta users produce two receipts in separate weeks and at least five ask for an ongoing responsibility such as signed updates, scheduled workflows, encrypted backup/export, or priority support. The paid plan must fund a responsibility HII actually performs; it cannot merely remove an artificial local limit.

### 4. Team implementation — later

Candidate price: $2,500–$10,000 per implementation.

Only offer after three workflows have been repeated across multiple users with stable permission boundaries, support documentation, and measurable time saved.

## Funnel

The launch site has two paths:

- `Get the Mac beta` for self-serve users.
- `Build my first workflow` for the $500 founder activation.

The beta path is:

download → launch → choose a folder → approve information → state one task → run → inspect receipt

The activation path is:

five-question application → qualification → payment and booking → workflow design → setup → first verified receipt → seven-day follow-up

Account creation is not the primary event. A verified receipt is.

## Unit economics and refund boundary

For each $500 activation:

- payment processing allowance: $20;
- founder delivery allowance: $200;
- support/risk allowance: $30;
- target contribution: $250, or 50%.

Offer a full refund when HII cannot complete the agreed bounded workflow during the activation. Do not guarantee business outcomes, model accuracy, or actions outside HII’s authority.

Five activations produce $2,500 revenue and, more importantly, five observed onboarding traces. Do not buy ads before those five customers complete or churn.

## Metrics that matter

Primary:

- time from app open to first verified receipt;
- percentage of installs that complete a receipt within 24 hours;
- percentage that complete a second receipt within seven days.

Commercial:

- qualified applications per week;
- application-to-paid-activation conversion;
- founder minutes per activation;
- refunds and their root causes;
- requests for ongoing paid responsibility.

Initial gates:

- median first receipt under 30 minutes;
- at least 60% of assisted users complete a second receipt within seven days;
- at least 50% contribution margin on the $500 activation;
- no critical permission, secret-handling, installer, or data-loss incident.

## Thirty-day launch sequence

### Build now

1. Enroll in Apple Developer Program and install the Developer ID Application certificate.
2. Create a `notarytool` keychain profile and run `npm run release:mac`.
3. Verify the generated archive and manifest on a clean Apple Silicon Mac.
4. Configure the public domain and deploy the launch site.
5. Put the notarized archive behind the download CTA.
6. Complete five paid founder activations manually.

### Build next

1. Instrument install, first-source approval, first run, receipt completion, and second-week receipt without collecting raw user information.
2. Turn the most repeated activation into an in-product guided workflow.
3. Publish three consented, redacted proof stories.
4. Decide whether the repeated paid responsibility is updates, automation, backup, support, or implementation.

### Later

- HII Pro subscription;
- team policy and shared workspaces;
- certified workflow packs;
- Windows support;
- a public capability ecosystem.

## Release gates

The public download remains closed until all are true:

- `npm run check`, targeted tests, and `npm run build` pass.
- The Tauri app is signed with a Developer ID Application identity.
- Apple notarization succeeds and the ticket is stapled.
- Gatekeeper accepts the app on a clean Mac without security workarounds.
- The archive includes `HII.app`, `hii-bootstrap.sh`, and `INSTALL.md`.
- `latest.json` records version, platform, byte size, and SHA-256.
- The first-run loop produces a real receipt.
- Uninstall and local-data deletion instructions have been verified.

No strategy is literally bulletproof. This one is defensible because every new promise is gated by observed use, every paid tier funds a concrete responsibility, and the company can reach its first revenue without building a speculative cloud platform.
