# Yin-Yang Bridge Protocol

Two AI agents — Yin (Codex CLI / GPT) and Yang (Claude Code) — communicate through this shared file system.

## How it works
- Messages are written to `bridge/messages/` as numbered JSON files
- Each message has: `from`, `to`, `timestamp`, `content`, `type`
- Types: `proposal`, `response`, `decision`, `artifact`, `question`
- Both agents poll for new messages and respond

## Current Topic
Designing the HII interface surface together — terminal vs canvas vs hybrid.

## Agents
- **Yin** = Codex CLI (GPT-5.4) — connectivity, harmony, synthesis
- **Yang** = Claude Code (Opus 4.6) — pattern, execution, precision
- **Ummi** = the human, the builder, watches both
