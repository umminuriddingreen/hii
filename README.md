# HII Test

HII is a local operator assistant for one machine. It gives you a command line for local AI chat, file search, repeatable skills, runtime jobs, memory, browser helpers, and machine-focused workflows.

This test branch removes the Yin/Yang bridge and cross-agent chat coordination layer. HII is now focused on local execution, local memory, and clear installation on macOS and Windows.

## What HII Does

- Chat with local or configured models from a CLI.
- Search and ingest local files for retrieval-assisted answers.
- Run registered local skills instead of remembering scattered scripts.
- Track work as durable runtime objects: intent, job, steps, artifacts, and memory.
- Serve local HTTP/dashboard surfaces for health, graph, tasks, and tools.
- Keep user-owned runtime state under `~/.hii`.

## What This Branch Excludes

- No Yin/Yang bridge commands.
- No bridge message files or bridge chat websocket.
- No cross-agent handoff log as a product feature.
- No seeded `bridge-send` or `bridge-read` skills.

## Repository Layout

- `src/` - TypeScript CLI, RAG, chat, tools, server, TUI surfaces.
- `hii/` - Python package surface for the HII runtime and local orchestration.
- `engine/` - Compatibility Python engine modules still used by older runtime paths.
- `agent-harness/` - Rhino/Grasshopper and ComfyUI harness utilities.
- `docs/` - Architecture and planning notes.
- `~/.hii/` - Runtime state created on the installed machine.

## macOS Install

Prerequisites:

- macOS 13 or newer.
- Git.
- Node.js 20 or newer.
- Python 3.11 or newer.
- Ollama, if you want local model serving.

Install:

```bash
git clone https://github.com/umminuriddingreen/hii-test.git
cd hii-test
npm install
npm run build
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -U pip
python -m pip install -e ".[dev]"
```

Optional local models:

```bash
ollama pull qwen2.5:32b
ollama pull deepseek-coder-v2:16b
ollama pull nomic-embed-text
```

Run:

```bash
npm start -- health
npm start -- chat "summarize this repo"
python -m hii --help
```

Install the TypeScript CLI globally from the checkout:

```bash
npm link
hii health
```

## Windows Install

Recommended path: Windows Terminal with PowerShell.

Prerequisites:

- Windows 11.
- Git for Windows.
- Node.js 20 or newer.
- Python 3.11 or newer from python.org or `winget`.
- Ollama for Windows, if you want local model serving.

Install:

```powershell
git clone https://github.com/umminuriddingreen/hii-test.git
cd hii-test
npm install
npm run build
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -U pip
python -m pip install -e ".[dev]"
```

If PowerShell blocks activation, run this once for your user:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

Optional local models:

```powershell
ollama pull qwen2.5:32b
ollama pull deepseek-coder-v2:16b
ollama pull nomic-embed-text
```

Run:

```powershell
npm start -- health
npm start -- chat "summarize this repo"
python -m hii --help
```

Install the TypeScript CLI globally from the checkout:

```powershell
npm link
hii health
```

## Common Commands

```bash
hii health
hii status
hii ingest --path ./workspace
hii chat "search files for auth middleware and explain"
hii chat --web "ground this with search"
hii papers "small local model RAG"
hii memory check --vault "/path/to/obsidian/vault"
hii serve --port 8787
```

Python runtime commands:

```bash
python -m hii daemon status
python -m hii skill list
python -m hii runtime jobs
```

## Configuration

Project config lives in `agent.config.json` when saved through the CLI.

Useful environment variables:

- `OLLAMA_URL` - default `http://127.0.0.1:11434`.
- `SEARXNG_URL` - default `http://127.0.0.1:8888`.
- `SERPAPI_KEY` - optional Google search provider key.
- `HII_OBSIDIAN_VAULT` - optional Obsidian vault path.
- `LM_STUDIO_URL` - OpenAI-compatible LM Studio URL.
- `HII_NOTES_PATH` - default note output folder.

## Runtime State

HII writes runtime state to `~/.hii`:

- `runtime.sqlite3` - strict runtime loop database.
- `hii.db` - broader local task/message state.
- `skills/` - registered local skills.
- `psyche.json` - local user profile state.
- `runtime/artifacts/` - generated job artifacts.

This state is machine-local and should not be committed.

## Development

```bash
npm run build
npm test
python -m pytest
python -m compileall hii engine
```

The codebase still contains TypeScript and Python runtime surfaces. For this branch, keep new user-facing work installable on both macOS and Windows, keep runtime state under `~/.hii`, and do not reintroduce bridge/Yin-Yang coordination features.
