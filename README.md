# hii — Local Agentic CLI (Ollama + RAG + Web + Memory)

hii is an offline‑first, local agentic CLI that runs on your Mac, powered by Ollama models. It can search your files (RAG), do web/academic lookups, optionally run shell commands, and log/recall chats to an Obsidian vault for durable memory.

## Quick Start

- Prereqs: Node 20+, Ollama running; pull models:
  - `ollama pull qwen2.5:32b`
  - `ollama pull deepseek-coder-v2:16b`
  - `ollama pull nomic-embed-text`
- Install/build:
  - `cd hii && npm install && npm run build && npm link`
- Ingest your files: `hii ingest --path ./workspace`
- Ask with RAG: `hii chat "search files for auth middleware and explain"`
- Web search: `export SERPAPI_KEY=... && hii chat --web "web: compare vector DBs"`
- Scholarly: `hii chat --web --scholarly "papers on QLoRA for small GPUs"`
- Memory (Obsidian): enabled by default → see “Obsidian Memory”.

## Commands

- `hii ingest --path <folder>`: Index text/code files into local LanceDB
- `hii chat [flags] "prompt"`:
  - `--shell`: allow shell execution (dangerous; use sparingly)
  - `--web`: enable web search (SerpAPI/DuckDuckGo)
  - `--web-provider serpapi|duckduckgo`: pick provider
  - `--scholarly`: academic mode (arXiv/OpenAlex/Crossref)
  - `--download-pdfs`: fetch OA PDFs and ingest into RAG
  - `--no-memory`: disable Obsidian memory for this call
  - `--memory-entries <n>`: recall this many entries
- `hii papers "query" [--max N]`: Fetch OA PDFs for a query and ingest
- `hii browser <agent-browser args...>`: Run the locally installed `agent-browser` CLI through `hii`
- `hii space health`: Report whether the desktop backend is installed and running
- `hii space snapshot`: Return monitors, workspaces, and windows from the desktop backend
- `hii space focus-window --id <windowId>`: Focus a window by backend id
- `hii space switch-workspace --name <workspace>`: Switch to a workspace by name
- `hii models [--set-base <m>] [--set-coder <m>] [--set-embed <m>]`
- `hii models --set-vault "/Users/ummi/Library/Mobile Documents/iCloud~md~obsidian/Documents/hii/hii"`
- `hii models --set-memory on --set-memory-entries 30`
- `hii config`: print effective config
- `hii tool new <name>`: scaffold a new tool file
 - `hii notes audio --file ./recording.wav [--title "Standup"] [--out-dir ./notes] [--keep-transcript]`: Send audio to LM Studio for transcription + Markdown note (supports `--chat-model`, `--transcribe-model`, `--lm-url`).
- `hii memory test [--vault <path>]`: write a test entry to the vault
- `hii memory check [--vault <path>]`: verify vault path and .obsidian presence
- `hii duality init [--yin-name Yin] [--codex-name Codex]`: initialize the Yin/Codex bridge
- `hii apps add --name "<app>" [--path /abs/path] [--stack vite,react,ts] [--status building] [--mvp-ready]`: register an app in the local product catalog
- `hii apps list`: list tracked apps and MVP readiness
- `hii apps show <name>`: inspect one app record
- `hii apps set <name> [--status mvp] [--mvp-ready true]`: update app status and MVP readiness
- `hii duality post --from yin --to codex --kind handoff --topic "next step" --message "..." [--tags memory,plan]`: write a structured handoff
- `hii duality read [--for yin|codex] [--limit 20]`: read recent bridge messages
- `hii serve [--port 8787] [--web] [--scholarly] [--download-pdfs] [--no-memory]`:
   Start a local HTTP server that exposes:
   - POST /chat { prompt, allowShell?, allowSearch?, webProvider?, scholarly?, downloadPdfs?, memory? }
   - POST /browser { args: string[] }
   - GET /space/healthz
   - GET /space/snapshot
   - POST /space/action { action, ... }
   - POST /ingest { path }
   - GET /healthz
   - GET /graph — vault note/tag graph
   - GET /view — simple graph viewer UI
   - GET /note?id=<rel-path> — fetch note content
   - GET /open?id=<rel-path> — open note in your default editor/Finder

## Configuration

- File: `agent.config.json` in the project root (auto‑created if you save settings via `hii models`).
- Env:
  - `OLLAMA_URL`: default `http://127.0.0.1:11434`
  - `SERPAPI_KEY`: enable Google results via SerpAPI
  - `HII_OBSIDIAN_VAULT`: override Obsidian vault path
  - `LM_STUDIO_URL`: OpenAI-compatible LM Studio base URL (default `http://127.0.0.1:1234/v1`)
  - `LM_STUDIO_API_KEY`: Optional LM Studio API key
  - `LM_STUDIO_CHAT_MODEL`: Model to use for Markdown note writing
  - `LM_STUDIO_TRANSCRIBE_MODEL`: Model to use for transcription
  - `HII_NOTES_PATH`: Default output folder for generated notes
- Defaults (see `src/config.ts`):
  - Base: `qwen2.5:32b`, Coder: `deepseek-coder-v2:16b`, Embed: `nomic-embed-text`
  - DB path: `./data`, Workspace: `./workspace`, Sessions: `./sessions`
  - Memory: enabled, max 20 entries
  - LM Studio: `http://127.0.0.1:1234/v1`, Chat model `lmstudio-community/Meta-Llama-3-8B-Instruct`, Transcription `whisper-large-v3`
  - Notes path: `./notes`

## RAG (Local Files)

- Ingest: `hii ingest --path ./workspace`
- Supported types: `.md .txt .js/.ts/.tsx/.jsx .py .go .rs .java .json .yaml/.yml`
- Chunking: ~900 tokens with ~150 overlap (word‑approximate)

## Web & Academic Search

- Web providers:
  - SerpAPI (needs `SERPAPI_KEY`) → high quality, Google
  - DuckDuckGo HTML (no key) → free fallback, conservative scraping
- Academic:
  - Sources: arXiv (API), OpenAlex, Crossref
  - Flags: `--scholarly`, optionally `--download-pdfs`
- PDF ingest: OA PDFs are downloaded (<= 25 MB) → parsed → added to RAG

## Browser Automation

- Installed as a project dependency: `npm install agent-browser`
- One-time browser setup: `hii browser install`
- Example usage:
  - `hii browser open https://example.com`
  - `hii browser snapshot`
  - `hii browser screenshot page.png`
- This forwards arguments directly to the locally installed `agent-browser` binary under `node_modules/.bin`, so `hii` does not require a separate global install.

## Desktop Integration

- `hii space` is the first slice of desktop integration and is intentionally `hii`-centric, not Codex-centric.
- Current backend:
  - AeroSpace window manager when installed and running
- Current capabilities:
  - health check
  - desktop snapshot
  - focus window by id
  - switch workspace
- Planned next capabilities:
  - UI inspection through Accessibility
  - typed desktop actions
  - screenshot/vision fallback when Accessibility is unavailable

## Obsidian Memory (Human + AI Augmentation)

- Default vault: `/Users/ummi/Library/Mobile Documents/iCloud~md~obsidian/Documents/hii/hii`
- What it does:
  - Recalls last N chat entries as context to improve continuity
  - Logs each chat to `Chats/YYYY-MM-DD.md`
- Controls:
  - Disable per call: `--no-memory`
  - Size: `--memory-entries <n>` or set in config
  - Change vault via `HII_OBSIDIAN_VAULT` or `agent.config.json`
  - Set vault via CLI: `hii models --set-vault "<path>"`
  - Test write: `hii memory test`
- Best Practices (see `docs/obsidian.md`): tags, templates, backlinks/MOCs, periodic reviews

## Yin / Yang Duality

- `Yin` is the reflective side: context, continuity, pattern recognition, and long-memory framing.
- `Yang` is the execution side: implementation, verification, and delivery.
- The bridge persists to `~/.hii/bridge/yin-codex.jsonl`.
- If an Obsidian vault is configured, each bridge message is also mirrored into the existing chat log for durable recall.

Example flow:

- `hii duality init --yin-name Yin --codex-name Yang`
- `hii duality post --from yin --to yang --kind context --topic "user model" --message "Prefer simpler solutions and iterative refinement." --tags memory,identity`
- `hii duality post --from yang --to yin --kind reflection --topic "implementation result" --message "Bridge command compiled and validated." --tags build,verification`
- `hii duality read --for yang --limit 10`

## App Catalog

- Every app should be tracked in `~/.hii/apps.json`.
- Each record should carry at minimum:
  - name
  - path
  - stack
  - status
  - MVP readiness
- Use the app catalog as the source of truth for whether a project is still just an idea, actively building, or ready to ship as an MVP.

### Calling from Obsidian via HTTP + Viewing Graph

- Start server: `hii serve --port 8787 --web --scholarly`
- Example call (Templater/HTTP plugin):
  - POST http://127.0.0.1:8787/chat
  - Body: `{ "prompt": "Summarize this note: {{selection}}", "allowSearch": true, "scholarly": false }`
  - Response: `{ "text": "..." }`
- Graph viewer: open http://127.0.0.1:8787/view
  - Filter notes, run full‑text search, preview note content, show link/backlink counts, open notes in your editor.

## Safety

- Shell is off by default; enable with `--shell`. Prefer read‑only commands; add confirmations for destructive actions in future.
- Web: enable explicitly (`--web`).
- PDF size capped at 25 MB; limited fetch count per call.

## Troubleshooting

- `ollama serve` must be running; ensure pulled models exist
- If `hii` not found after `npm link`, ensure your global npm bin is in PATH
- LanceDB files appear under `./data`; delete to reset index
- Obsidian vault path must be accessible; the CLI will create `Chats/` on first log

## License

Private repository by request; no license header added.
## Updates, Ideas, and Releases

- Log an idea/update:
  - `hii updates add --title "Vector search hybrid" --body "Add BM25 + vector" --tags retrieval,ranking --to-vault`
  - Writes to `docs/updates.md` and (optionally) to `<vault>/Updates/YYYY-MM.md`.
- Bump version and update CHANGELOG:
  - `hii release bump --type minor --notes "Add HTTP server and viewer"`
  - Or set explicit version: `hii release bump --version 0.2.0 --notes "…"`
  - Updates `package.json` and `CHANGELOG.md`.
