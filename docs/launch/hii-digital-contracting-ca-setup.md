# HII digital contracting customer-acquisition setup

Date: 2026-08-19
Status: working operating plan

This document turns the faceless X/Twitter launch idea into a concrete
customer-acquisition and install flow for HII as digital contracting.

The simple category:

> Contractors install physical systems. HII installs digital systems.

Do not lead with AI software, agents, dashboards, or websites. Lead with the
installed business function.

## Offer

Name:

> HII Install

What it is:

> Digital contracting for small businesses.

What it does:

> HII audits a business, shows the broken customer path, generates the fix, and
> installs the working lead, booking, follow-up, review, or quote-request system.

What the client buys:

- A visible before/after audit.
- A working installed digital tool.
- A receipt of what changed.
- Optional monthly maintenance.

What HII keeps private:

- audit scoring logic;
- prompts and templates;
- generation pipeline;
- deployment scripts;
- reusable internal capability library;
- source repositories for HII core.

What the client may receive:

- the deployed website or page;
- static exported files when the package includes export;
- account connection instructions;
- DNS records to add;
- limited admin invite requests;
- a plain-language install receipt.

## First drop

Start with one narrow install, not a bundle.

Drop:

> The Booking Fixer

Promise:

> We find where people fall out of your booking flow, show the fixed version,
> and install it.

Who it is for first:

- barbers;
- detailers;
- cleaners;
- tattoo artists;
- medspas;
- mobile service businesses;
- any local business that already gets inquiries but loses people before
  booking or quote request.

Do not start with every business type. Pick one niche per seven-day sprint.

## Funnel

Public post:

> Your business should not make customers work this hard to book.
>
> Reply `audit` with your business link.
> I will show the drop-off and the fix.

Reply path:

1. Ask for business URL, Google Maps, Instagram, and the desired customer action.
2. Run a free lightweight audit without credentials.
3. Send a short before/after preview.
4. Offer a paid install.
5. Collect only the access required for the chosen install path.

The conversion event is not account creation. It is:

> business link -> audit -> fixed preview -> paid install

## Access and credentials

Default rule:

> Never ask for passwords.

Use these instead:

- OAuth where supported.
- Invite links.
- Temporary limited admin access.
- DNS records the client adds themselves.
- Dedicated service accounts.
- Client-owned accounts with HII added as a collaborator.

Only request access after payment or explicit install approval. The free audit
uses public information and manually supplied goals only.

## IP protection

Use Git internally, but do not ship the factory.

Repository structure:

```text
hii-core/                private; never shipped
hii-audit-tools/         private; scoring and generation
hii-install-templates/   private or licensed
client-sites/name/       generated output only
client-receipts/name/    install notes, proof, handoff
```

Delivery models:

1. HII-managed install
   - HII hosts or controls deployment.
   - Client gets the working result and receipt.
   - Best IP protection.
   - Best recurring maintenance revenue.

2. Client-owned export
   - Client gets generated static files or a repo containing only their output.
   - No HII generator code.
   - Higher setup fee, weaker recurring revenue.

Recommendation:

> Start HII-managed. Sell export later as a premium package.

## Pricing

Starter audit:

- Free public teaser.
- No credentials.
- One visible customer-path issue and one fixed preview.

Install packages:

| Package | Price | Best for | Includes |
| --- | ---: | --- | --- |
| Fix | $300-$750 | one broken flow | one page, form, CTA, or booking repair |
| Install | $1,000-$2,000 | serious local operator | page or mini-site plus lead capture and follow-up |
| Maintain | $100-$500/mo | recurring operations | updates, monitoring, small copy changes, repair |

Do not sell below the cost of founder attention. The model/API cost is tiny
compared with discovery, setup, client communication, revisions, and support.

## Token and compute operating estimate

Pricing verified against OpenAI public API pricing pages on 2026-08-19:

- GPT-5 mini: $0.25 per 1M input tokens, $2.00 per 1M output tokens.
- GPT-5 nano: $0.05 per 1M input tokens, $0.40 per 1M output tokens.
- GPT-5.6 Luna: $0.20 per 1M input tokens, $1.20 per 1M output tokens.
- GPT-5.6 Terra: $2.00 per 1M input tokens, $12.00 per 1M output tokens.

Sources:

- <https://openai.com/gpt-5/>
- <https://developers.openai.com/api/docs/models/gpt-5-mini>
- <https://openai.com/index/advancing-the-price-performance-frontier-with-gpt-5-6/>

Rough per-audit cloud cost:

| Work unit | Assumed tokens | Model | Approx cost |
| --- | ---: | --- | ---: |
| Public-profile audit | 20k input + 4k output | GPT-5 nano | $0.0026 |
| Solid audit + rewrite | 60k input + 12k output | GPT-5 mini | $0.039 |
| Premium strategy pass | 120k input + 20k output | GPT-5.6 Terra | $0.48 |

Local RTX compute has no per-token API fee, but it still costs electricity,
hardware wear, setup time, model download/storage, and queue time. Treat local
inference as margin protection and privacy leverage, not as literally free.

Operating rule:

> Use local or cheap models for audit extraction, scoring, and first drafts.
> Use stronger models only for final strategy, copy, and edge cases.

At $300+ per install, token cost should be well under 1% of revenue if the
workflow stays bounded.

## Install receipt

Every paid install should produce a simple receipt:

```text
Client:
Business URL:
Install name:
Goal:
Before:
Changed:
Connected accounts:
Access used:
Files or deployment:
Verification:
Ongoing owner:
Maintenance terms:
Rollback:
```

This receipt is the trust layer. It is also the seed for repeatable HII
capabilities.

## Seven-day X/Twitter sprint

Daily rhythm:

1. Post one named problem.
2. Ask for one business link.
3. Audit one public example.
4. Show the fixed path.
5. Offer the install.

Post templates:

1.

> Your Google Maps profile is probably your real homepage.
>
> If the path from Maps -> call/book/quote is messy, you are leaking customers.
>
> Reply `audit` with your business link. I will show the leak.

2.

> Websites are cheap now.
>
> Installed customer flow is not.
>
> HII installs the part that gets the lead, booking, review, or quote request.

3.

> The new flex for local businesses is instant follow-up.
>
> If someone asks for a quote and waits two days, that lead is already cold.
>
> HII installs the follow-up.

4.

> I am taking 5 businesses for The Booking Fixer drop.
>
> Free audit first.
> Paid install only if the fix is obvious.
>
> Reply `audit`.

5.

> A contractor installs the water heater.
>
> HII installs the booking flow.
>
> Same idea. Different system.

6.

> Your business should not look abandoned online if you are alive in real life.
>
> HII installs the digital proof that you are open, sharp, and ready to book.

7.

> Free audit prompt:
>
> Drop your business link.
> Tell me the action you want: calls, bookings, quote requests, reviews, or DMs.
>
> I will show the first leak.

## Definition of done for the first real install

Done means:

- one customer chose a paid install;
- no passwords were collected;
- HII kept generator IP private;
- the client received a working result;
- the install receipt names what changed and how it was verified;
- HII can repeat the workflow for the next similar business.

Do not scale posting before one install is completed and written up as a proof
story.
