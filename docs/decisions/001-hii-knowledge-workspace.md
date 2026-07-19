# ADR 001 — HII Knowledge Workspace

**Status:** accepted by founder instruction
**Date:** 2026-07-14; amended 2026-07-18
**Owner:** Ummi Nuriddin Green

## Decision

HII will include an Obsidian-class local knowledge workspace as a first-party
surface. This explicitly reopens and supersedes the prior Context Dock 0.1
anti-goal that prohibited an Obsidian-style knowledge layer.

The workspace is not a separate product, repository, daemon, runtime, or
database. It extends Context Dock's source-linked project model and uses the
existing HII/AII boundary:

```text
human notes, sources, assets, and decisions
→ user-selected Markdown vault (canonical authored knowledge)
→ ~/.hii/hii.db (rebuildable index and operational ledger)
→ deterministic links, tags, FTS5, graph, systems objects, and provenance
→ bounded AII capabilities
→ agent context, receipts, and reusable skills
```

## Required capability set

- Markdown notes and folders
- wikilinks, resolved links, unresolved links, and backlinks
- tags and nested tags
- full-text search
- graph view and local note graph
- daily notes
- pinning and recent notes
- split editor and preview
- outlines and task lists
- version history
- trash and restore
- Markdown and JSON import/export
- command palette and keyboard navigation
- copied or explicitly linked assets with hashes and availability checks
- source-linked system objects, relations, saved views, and proposal review
- Markdown-vault authority with rebuildable SQLite indexing
- local persistence, events, receipts, and capability metadata

Plugins, proprietary sync behavior, publishing, payments, and external
distribution remain separate later decisions. “Every feature” means aggressively
closing the complete local knowledge loop before adding a marketplace or cloud
dependency; it does not authorize copying proprietary code or branding.

## Constraints

- Use `/Users/ummi/hii`, one user-selected Markdown vault, and `~/.hii/hii.db`.
- Markdown files and copied original assets are authoritative for authored knowledge.
- Use SQLite for deterministic indexing, history, provenance, events, and operational state; the note index must be rebuildable from the vault.
- Use explicit migrations and typed server contracts.
- Keep note content local unless the user explicitly sends or exports it.
- Keep agent mutations bounded and receipt-producing.
- Preserve source provenance and version history.
- Use deterministic parsing and FTS5 before model-based organization.
- Track implementation in small local Git commits; never infer push authority.

## First proof

A user can create, edit, link, search, graph, version, trash, restore, import,
export, and externally edit real Markdown notes from `/knowledge`; add copied
or linked assets; turn a source into a reviewed System Map; and restart without
losing the vault, object relationships, or local receipts. Every mutation
produces local evidence and no content leaves the machine implicitly.
