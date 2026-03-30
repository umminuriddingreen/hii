# HII Apple Notes Master Map

## Overview

This note is the non-destructive control surface for Apple Notes inside HII.

Goal:
- show the current note landscape
- group notes into useful clusters
- preserve all original notes unchanged
- give HII a living knowledge graph it can expand over time

Current known inventory is shallow in some folders and very dense in others, so this first version is metadata-first. It is meant to be enriched later with note bodies, sections, links, and recurring entities.

## Account Tree

```text
Apple Notes
├── gmail personal
│   └── HII (2)
├── iCloud
│   ├── +++ (11)
│   ├── --- (18)
│   ├── ___ (869)
│   ├── ARCHITECT (4)
│   ├── BUSINESS (0)
│   ├── Notes (18)
│   ├── PROMPTS (2)
│   └── Recently Deleted (1)
├── maisoniseverything@gmail.com
│   └── Notes (0)
└── school
    └── Notes (0)
```

## Knowledge Graph Sketch

```text
[Apple Notes]
   |
   +--> [gmail personal/HII] ----> [HII setup + execution notes]
   |
   +--> [iCloud/ARCHITECT] -----> [architecture, systems, planning]
   |
   +--> [iCloud/PROMPTS] --------> [prompt library, reusable patterns]
   |
   +--> [iCloud/___] ------------> [high-volume general corpus]
   |                                 |
   |                                 +--> [ideas]
   |                                 +--> [research]
   |                                 +--> [workflows]
   |                                 +--> [reference]
   |
   +--> [iCloud/Notes] -----------> [general notes]
   |
   +--> [iCloud/+++] / [iCloud/---] -> [unknown semantics, inspect later]
   |
   +--> [maisoniseverything@gmail.com/Notes]
   |
   +--> [school/Notes]
```

## Non-Destructive Organization Proposal

Do not move or delete anything yet.

Recommended clusters:
- `HII / execution` for system setup, remote access, sessions, generations, and operational notes
- `HII / remote` for Umbrel, Windows PC, SSH, Tailscale, browser panes
- `HII / prompts` for reusable intent templates and working prompts
- `HII / architecture` for system design, diagrams, roadmaps, and execution substrate thinking
- `HII / knowledge graph` for map notes, note indexes, and summaries of note families
- `HII / archive` for older or low-signal notes you want preserved but not foregrounded

Recommended renames:
- `+++` -> inspect semantics before renaming
- `---` -> inspect semantics before renaming
- `___` -> inspect semantics before renaming
- `Notes` -> `General` only if it is truly a catch-all
- `PROMPTS` -> `Prompt Library`
- `ARCHITECT` -> `Architecture`

Recommended tags:
- `#hii`
- `#remote`
- `#execution`
- `#architecture`
- `#research`
- `#prompt`
- `#archive`

Rules:
- preserve original folders until the meaning is verified
- add index notes before restructuring
- use the master note as the map, not as the storage location

## Staged Action Plan

1. Create the master note and keep it as the top-level index.
2. Add a per-folder index note for the dense iCloud folders.
3. Extract note titles and dates into the graph before touching note bodies.
4. Classify the dense folders by theme using metadata only.
5. Add linked summaries for major note families.
6. Enrich the graph with body text, section headings, and recurring entities.
7. Only after the map is stable, propose folder renames or tag cleanup.

## Later Enrichment

Once full note-body metadata is available, this note can be upgraded with:
- section summaries for each important note
- backlinks between related notes
- recurring entity tracking for people, tools, projects, and systems
- timeline views for recent changes
- note cluster summaries by topic and folder
- a true active knowledge graph that shows how ideas connect over time

## Implementation Summary

- Built a metadata-first master note instead of a destructive reorganizer.
- Included an ASCII inventory of the accessible Notes account structure.
- Sketched a knowledge graph around accounts, folders, and semantic clusters.
- Proposed non-destructive clusters, renames, and tags only.
- Added a staged plan that starts with indexing and classification before any restructuring.
- Left room for later enrichment with note bodies, sections, backlinks, and timelines.
- Kept the draft compact enough to live as a single living index note in HII.
