# HII runtime

Internal modules owned by HII CLI. This is part of HII, sharing its registry, authority, model routing, work, and receipts.

- `daemon/`: bounded work, context, jobs, and receipts
- `model-runtime/`: Mac and Windows model lifecycle and routing
- `capabilities/`: canonical capability definitions
- `skills/`: proof-backed reports and skill proposals
- `codex/`: native Codex protocol schemas
- `admin-agent/` and `scripts/`: internal workflow adapters

Use `hii` commands to operate these modules. Durable state remains in `~/.hii`; moving source modules does not migrate user data. Older installed releases retain their own resources until replaced.
