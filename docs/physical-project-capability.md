<!-- SPDX-License-Identifier: LicenseRef-BSL-1.1 -->

# HII Project Operations and Physical Computation

`hii project` turns an organizational objective into a governed execution plan:

```text
objective
→ KPI and stakeholder question
→ phase and delivery option
→ dependent task
→ budget line and supplier requirement
→ evidence and approval
→ phase advancement
→ durable operational history
```

The first domain profile is architectural project delivery. The underlying
records are general enough for an organization, personal practice, product,
event, fabrication, or other physical project.

## Create a project

HII does not invent a market billing rate. The operator must enter the baseline
hours and loaded blended rate. Money is stored as integer minor units and
percentages as basis points.

```bash
hii project create "Community Workshop" \
  --project-type architecture \
  --location "Newark, NJ" \
  --currency USD \
  --budget 1250000.00 \
  --base-hours 1400 \
  --blended-rate 185.00 \
  --consultant-allowance 45000.00 \
  --direct-costs 7500.00 \
  --contingency-bps 1000 \
  --options 3
```

This creates:

- objectives and deterministic KPI definitions;
- stakeholder questions and decision boundaries;
- SD, DD, CD, and Active Project Development phases;
- a dependency-ordered project job graph;
- multiple architectural delivery options with phase and job line items;
- a physical project budget allocation by building system;
- supplier requirements linked to budget lines;
- assumptions, exclusions, approvals, evidence, and an append-only operation
  trail.

The living project is a graph-native operational object in `~/.hii/hii.db`.
`~/.hii/projects/<id>.json` is a private portable snapshot for inspection,
recovery, and future export; it is not a competing task database.

## Architecture phases

| HII phase | Meaning | Required gate |
| --- | --- | --- |
| `sd` | Schematic Design | verified brief/site context, alternatives, initial system coordination, cost/schedule/risk package, selection |
| `dd` | Design Development | selected design resolution, consultant/system coordination, envelope/material development, code review, updated approval package |
| `cd` | Construction Documents | coordinated drawings/specifications/details, consultant integration, constructability and QA, reviewed issue set |
| `active-project-development` | Post-CD active delivery stream | procurement/submittals, RFIs/changes, observations, budget/schedule reporting, closeout |

“Active Project Development” is currently modeled as the active post-CD
delivery stream. A future profile can rename or rescope it without changing the
generic objective, task, KPI, budget, supplier, evidence, or approval records.

## Price and compare options

```bash
hii project show <project>
hii project price <project> --base-hours 1550 --blended-rate 190 --options 4
hii project select <project> coordinated --by "Decision maker"
```

The built-in option profiles are planning multipliers, not market facts:

- Essential: lean alternatives and coordination.
- Coordinated: normal planning baseline.
- Integrated: broader systems and stakeholder iteration.
- High Assurance: expanded validation and risk reduction.

Every option exposes its hours, job line items, consultants, direct costs,
contingency, markup, phase totals, total, and effective percentage of the entered
construction budget. Repricing creates a new semantic revision. Earlier
approvals remain visible as history but no longer satisfy the new revision.

## Organizational KPI and task triage

```bash
hii project stakeholder-add <project> "Community Board" \
  --role Stakeholder \
  --decision-scope "Program priorities and public milestone approval"

hii project kpi-add <project> "Local procurement" \
  --unit percent \
  --target 40% \
  --calculation "local committed value / total committed value" \
  --owner "project manager"

hii project kpi-update <project> kpi-local-procurement 12% \
  --source receipt:procurement-ledger

hii project task-add <project> "Confirm local supplier participation plan" \
  --phase sd \
  --system procurement \
  --owner "project manager" \
  --depends-on sd-1 \
  --kpi kpi-local-procurement \
  --budget-line budget-general-conditions \
  --evidence "approved supplier participation plan"

hii project triage <project>
```

Triage reports task progress, budget source coverage, stakeholder-question
resolution, supplier-quote coverage, budget forecast, custom KPI readings,
highest-priority attention items, and concrete next actions. A custom KPI reading
without a source remains marked for attention.

## Stakeholder and shareholder questions

```bash
hii project question-add <project> "Which milestone needs board approval?" \
  --asked-by "Board chair" \
  --owner "project sponsor"

hii project question-answer <project> <question> "SD option selection" \
  --source receipt:board-resolution
```

Questions retain the asker, accountable owner, answer state, and source
references. Scope-affecting changes create a new revision so an answer cannot
silently inherit an older approval.

## Supplier discovery and contact boundary

```bash
hii project supplier-search <project> need-structure --limit 8
hii project rfq <project> need-structure
hii project supplier-quote <project> <need> <supplier> 190000.00 \
  --source https://supplier.example/quote
```

Supplier discovery uses local SearxNG first and falls back to bounded public web
search. Results are candidates with visible URLs, never automatically approved
suppliers. A recorded quote replaces the linked allowance forecast and retains
its source.

`rfq` generates an explicitly unsent draft. Searching and drafting do not grant
authority to contact a supplier, accept terms, spend money, place an order, or
make another external commitment. Those actions require a separate
external-commit approval and an appropriate HII communication or purchasing
capability.

## Evidence and phase gates

```bash
hii project task-complete <project> sd-1 \
  --evidence receipt:site-context

hii project phase-approve <project> sd \
  --by "Decision maker" \
  --note "Approved after scope, budget, alternatives, and evidence review"

hii project advance <project>
```

HII refuses phase approval or advancement unless:

- a delivery option is selected;
- every current-phase task is complete;
- each completion carries a `receipt:<id>` evidence reference;
- approval names an actor and rationale;
- the approval matches the current project revision and selected option.

HII prepares planning and coordination evidence. It does not impersonate a
licensed architect, engineer, surveyor, code official, cost estimator,
contractor, attorney, or financial professional, and it does not turn an
allowance or web result into a bid.
