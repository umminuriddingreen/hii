# Using hii with Obsidian for Human–AI Augmentation

This guide shows how to pair the `hii` CLI with an Obsidian vault so your AI assistant can remember context across sessions and help you build a durable knowledge base.

## Vault Setup

- Default path (macOS iCloud Obsidian):
  `/Users/ummi/Library/Mobile Documents/iCloud~md~obsidian/Documents/hii/hii`
- You can change the path with `HII_OBSIDIAN_VAULT` env or in `agent.config.json`.
- The CLI writes to `Chats/YYYY-MM-DD.md`. It creates the folder on first use.

## Recommended Structure

- `Chats/` — auto‑generated daily logs by `hii`
- `Projects/` — your project notes
- `Ideas/` — raw ideas, sketches
- `People/` — notes on collaborators/experts
- `MOCs/` — Map‑of‑Content hub notes linking related topics
- `Refs/` — reference notes (papers/books), one per source

## Best Practices

- Use consistent tags: `#task`, `#idea`, `#decision`, `#ref`, `#paper`
- Add back‑links from `Chats` entries to relevant notes, e.g., `[[Project X]]`.
- Create a daily/weekly review note that summarizes key decisions and links to chat entries.
- For research, create a `Refs/<title>.md` note and paste bibliographic data + link/DOI; link chats that mention it.
- Keep prompts short and focused; rely on memory to bring recent context.

## Workflow Patterns

- Research loop:
  1) `hii chat --web --scholarly "papers on <topic>"`
  2) Skim results; run `hii papers "<topic>" --max 2` to fetch OA PDFs
  3) `hii chat "Summarize key methods and compare to my approach in [[Project X]]"`
- Coding loop:
  - `hii ingest --path ./workspace` then
  - `hii chat "search files for <module> and suggest refactor"`
- Decision tracking:
  - After a decision, add a short `#decision` block in the chat or a linked note; memory recall will surface it later.

## Plugins (Optional)

- Dataview: query tags across `Chats` and surface action items
- Calendar or Periodic Notes: daily logs overview
- Advanced URI: jump from Obsidian to terminal tasks

## Privacy & Sync

- Your vault stays local (or iCloud via Obsidian). The CLI writes only Markdown logs.
- Web/academic tools run only when you pass `--web`.

## Troubleshooting

- No logs? Ensure the vault path exists and write permissions are available. The CLI creates `Chats/` if missing.
- Recall too long/short? Use `--memory-entries <n>` or change `memoryMaxEntries` in config.
- Want a fresh context? Use `--no-memory` for that call.

