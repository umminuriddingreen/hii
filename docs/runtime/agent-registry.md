# Local HII agent registry

HII owns the private durable registry at `~/.hii/agents/registry/`. JSON snapshots use atomic replacement and a process-owned exclusive lock. Web surfaces consume the same registry API; browser state is not run authority.

`hii agents sync --json` discovers bounded local Codex, Claude, Gemini, Hermes, HII chat and native run receipt metadata. Original provider session files remain authoritative and read only. There is no remote session sync claim.

- `hii agents sessions --source Codex --workspace /path --query words --json`
- `hii agents session codex:ID --json`
- `hii agents runs --json`
- `hii agents events RUN_ID --json`
- `hii agents workspace read --json`
- `hii agents workspace write --json` reads the versioned workspace document from stdin.

Internal `registry.recordRun` records actual process lifecycle, native run ID and receipt pointer; `registry.event` stores bounded operational events with model context removed. Discovered external sessions have Unknown status, never invented liveness. Session excerpts omit tools and injected instructions and redact obvious credential formats; this is not a general guarantee that arbitrary prose contains no private data. Sync is local and explicitly requested. Stored event history caps at about 2 MiB per run and metadata caps at 3,000 records.
