# Project sources

HII can bind references and bounded excerpts to a computational project without
copying large working files into a second store. Project sources live in HII's
operational graph in the same canonical `hii.db` as the project binding.

## Supported source kinds

- `local-file`: a file inside the bound project root.
- `rhino`: a `.3dm` or related file inside the bound project root. HII records
  file metadata and a fingerprint; it does not copy the model.
- `notion`: an official HTTPS Notion page URL with a user-supplied title,
  summary, and optional metadata.
- `chatgpt-conversation`: a bounded reference produced from an explicit
  official ChatGPT data export.
- `conversation`: a stable link from a bound project to a complete visible
  ChatGPT or Codex conversation in HII's local archive.

## Commands

```powershell
hii project source-add <project-id> `
  --source-kind rhino `
  --locator 'C:\project\site.3dm' `
  --title 'Authoritative site model' `
  --summary 'Terrain and site context'

hii project source-add <project-id> `
  --source-kind notion `
  --locator 'https://app.notion.com/p/...' `
  --title 'Studio requirements' `
  --summary 'Current deliverables and program requirements'

hii project sources <project-id>
hii project sources <project-id> --query 'terrain program'

hii project import-chatgpt <project-id> 'C:\exports\chatgpt' `
  --query 'ARCH495 Natirar' `
  --limit 50
```

`import-chatgpt` accepts an extracted official export directory or its
`conversations.json`. It requires a relevance query, imports at most 500
references, and stores only a bounded matching excerpt and source metadata. It
does not store the full transcript. Extract an export ZIP before import.

## Authority and privacy boundary

Local and Rhino paths must resolve inside the bound project root; symlink and
path escapes are rejected. Notion capture is reference-based and does not store
connector credentials. ChatGPT import never reads browser Cookies, session
tokens, private endpoints, or Chromium application caches. Local Codex session
files remain labeled as Codex conversations and must not be labeled as consumer
ChatGPT history. The canonical `hii mcp` server exposes project-aware archive
sync, search, full-message reads, and chat-to-project linking as `workflow_*`
tools; see `CONVERSATION_ARCHIVE_AND_AGENT_HANDOFF.md`.
