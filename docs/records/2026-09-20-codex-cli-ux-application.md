# Codex CLI UX patterns applied to HII

Reference inspected locally: `codex-cli 0.155.1`.

## Applied

| Codex pattern | HII expression |
| --- | --- |
| `codex exec` / `e` | `hii exec` / `hii e` aliases for the governed `hii run` |
| `-C`, `--cd` | Aliases for HII's bounded `--cwd` workspace |
| `-m` | Short form of HII's local `--model` selection |
| prompt `-` from stdin | `hii exec -` reads a trimmed goal from stdin and rejects empty input |
| `-o`, `--output-last-message` | Aliases for HII's receipt-linked `--last-message` artifact |
| `--ask-for-approval on-request` | Compatibility spelling for HII `--asks sensitive`; authority remains separately enforced |
| non-interactive JSON events | Existing HII `--json` and `--jsonl` outputs |
| concise help plus full discovery | Existing `hii --help`, `hii help --all`, `hii find`, and shell completions |
| session resume/fork | Existing durable HII chat `/resume` and `/fork`, plus objective `hii thread` state |
| MCP/app-server separation | Existing HII MCP, ACP, Codex app-server, daemon, and runner boundaries |

## Intentionally not copied

- Codex sandbox names are not aliases for HII authority. HII distinguishes
  `read-only`, `workspace`, `external-preview`, and `external-commit` because
  these are receipt-bearing authority envelopes rather than presentation labels.
- HII does not silently map Codex's dangerous bypass flag to `--yolo`. HII keeps
  the explicit workspace and secret guards described in `hii run --help`.
- Codex feature flags are not conflated with HII capabilities. HII capabilities,
  packs, skills, tools, and runtime feature state have different trust and proof
  meanings and remain discoverable through their existing commands.

## UX rule

Familiar spelling may be accepted at HII's edge, but the resulting run must use
HII's authority, local-model routing, context compilation, verification, receipt,
and cross-system execution contracts.
