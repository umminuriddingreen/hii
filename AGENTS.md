# Repository Guidelines

## Project Structure & Module Organization
- `src/cli.ts`: CLI entrypoint that wires commands (`ingest`, `chat`, `models`, `updates`, `release`, `memory`, `serve`).
- `src/agent.ts`, `src/tools/*`, `src/clients/ollama.ts`: core agent loop, tool implementations (RAG, shell, search, academic, papers), and model client.
- `src/rag/*`, `src/store/vectordb.ts`: chunking/ingest pipeline and LanceDB wrapper for embeddings.
- `src/server.ts`, `public/`: HTTP server and static viewer assets for graph/search UI.
- `docs/obsidian.md`: usage notes for Obsidian vault memory; `README.md` and `CHANGELOG.md` describe commands and releases. Runtime data (`data/`, `sessions/`, `workspace/`) is created locally and not committed.

## Build, Test, and Development Commands
- Install deps: `npm install` (Node 20+).
- Type-check/build: `npm run build` (emits `dist/`).
- Dev (TS directly): `npm run dev` to run the CLI via `ts-node`.
- Run compiled CLI: `npm start` or `node dist/cli.js <command>` after building.
- Useful flows: `hii ingest --path ./workspace`, `hii chat "..."`, `hii serve --port 8787 --web --scholarly`, `hii updates add --title "..."`, `hii release bump --type minor --notes "..."`.

## Coding Style & Naming Conventions
- Language: TypeScript ES modules; 2-space indent, single quotes, semicolons, `camelCase` for functions/vars, `PascalCase` for classes/types.
- Prefer async/await with explicit error messages; exit with non-zero codes on CLI failures (see `src/cli.ts`).
- Keep config defaults centralized in `src/config.ts`; avoid duplicating paths/models in callers.
- Place new tools under `src/tools/` and export functions; scaffold via `hii tool new <name>` when possible.

## Testing Guidelines
- No automated test suite yet; rely on `npm run build` for type safety before sending changes.
- Manually exercise CLI flows relevant to your change (e.g., ingest sample folder, chat with `--web`/`--scholarly`, start server and hit `/healthz` or `/graph`).
- When adding behavior that touches Obsidian, verify vault detection with `hii memory check --vault <path>`.

## Commit & Pull Request Guidelines
- Git history follows Conventional Commits with scopes (e.g., `feat(server): add /graph endpoint`, `fix(rag): clamp chunk size`). Match that pattern for new commits.
- Keep PRs small and focused; describe the user-facing change, flags added, and manual test steps. Update `README.md` or `docs/obsidian.md` if commands, env vars, or defaults change.
- Note any new runtime assets (data directories, generated notes) that should remain git-ignored. If you bump versions via `hii release bump`, ensure `CHANGELOG.md` is updated accordingly.

## Security & Configuration Tips
- Do not commit secrets; set `SERPAPI_KEY`, `HII_OBSIDIAN_VAULT`, and `OLLAMA_URL` via env or `agent.config.json` in the repo root.
- `--shell` is opt-in for `chat`; keep commands read-only when possible. Large PDF downloads are capped; respect the 25 MB limit in scholarly mode.
- For any information-retrieval task, MUST use native CLI and local search first: `rg`, `rg --files`, local docs, RAG, and CLI-native search surfaces. Use SearxNG or other web search only after local search is insufficient or the user explicitly asks for web grounding.
