# HII Skill Growth Contract

HII compounds verified work through an AII-owned local registry:

```text
agent action → receipt → repeatable draft → verification → review → registered skill → local export
```

## Runtime coordinates

```text
~/.hii/skills/actions.jsonl              append-only agent-action receipts
~/.hii/skills/proposals.jsonl            append-only draft/promotion events
~/.hii/skills/proposed/<id>/              draft SKILL.md and manifest
~/.hii/skills/registry.json              active registered-skill index
~/.hii/skills/registered/<id>/            reviewed SKILL.md and manifest
~/.hii/skills/exports/                    local portable packages and export log
```

Legacy flat JSON files and `_index.json` under `~/.hii/skills` remain reference
material. They are not automatically executable or imported into the active
registry.

## Reporting

Agents should report meaningful completed, partial, failed, or blocked work.
The receipt records actor, project, intent, actions, commands, files,
capabilities, outcome, verification, proof, permissions, side effects, next
action, and repeatability. Secret-like values are redacted before persistence.

Use `--file <receipt.json>` for a complete structured record or CLI flags for a
small receipt:

```sh
hii skill report \
  --agent codex \
  --agent-kind codex \
  --project hii \
  --coordinate /Users/ummi/hii \
  --summary "Added and verified a reusable workflow" \
  --outcome completed \
  --verification verified \
  --checks "npm run hii:skills:check,npm run build" \
  --proof "/path/to/receipt" \
  --permissions "edit approved repository" \
  --side-effects "writes local build output" \
  --repeatable \
  --skill-id verify-hii-workflow
```

`--repeatable` creates or updates a draft. It does not grant execution
authority.

## Creation and registration

Create or refine a draft bundle:

```sh
hii skill create verify-hii-workflow \
  --name "Verify HII Workflow" \
  --description "Run the bounded HII checks and preserve evidence." \
  --instructions "Inspect live state, run the approved checks, and report proof." \
  --verify "npm run hii:skills:check,npm run build" \
  --permissions "read and build the approved repository" \
  --side-effects "writes local build output" \
  --from-report <receipt-id>
```

Register only after review:

```sh
hii skill register verify-hii-workflow --reviewed-by ummi
```

Registration fails without a verification command or a verified source
receipt. Registered skills record their reviewer, proof provenance,
permissions, and side effects.

## Discovery and health

```sh
hii skill list
hii skill list --all
hii skill search build
hii skill show verify-hii-workflow
hii skill doctor
```

## Portable export

```sh
hii skill export verify-hii-workflow --include-provenance
```

Optional local distribution metadata can be added with `--license`,
`--price-cents`, and `--currency`. This describes a potential package; it does
not publish, upload, sell, charge, or grant a license. Inspect the exported
`.hii-skill.json` before any separately authorized distribution.
