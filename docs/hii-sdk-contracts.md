# HII SDK Contracts

HII is a local-first control plane for verified agent work. The SDK surface is deliberately small: it names what can run, how work moves through state, what budget was quoted, what ledger events happened, and which proof artifacts make the result reviewable.

## Core Records

### CapabilityDefinition

Describes one action HII can expose. Required fields include `id`, `name`, `owner`, `runtime`, `summary`, `inputs`, `outputs`, `permissions`, `visibility`, `costModel`, `evidence`, `status`, and `trustLevel`.

Current examples include `hii.terminal.observe`, `hii.board.task_kanban`, `hii.credits.quote`, `hii.rhino.managed_job`, and `hii.links.publish_stream`.

### CapabilityJob

Tracks bounded work requested through a capability. Jobs move through the allowed statuses `queued`, `running`, `waiting_approval`, `completed`, `failed`, and `cancelled`.

The important fields are `capabilityId`, `inputSummary`, `status`, `logs`, `ledger`, `proofArtifacts`, `createdAt`, and `updatedAt`.

### CapabilityQuote

Captures budget before execution. A quote includes estimated tokens, estimated minutes, compute cost, HII platform fee, total cost, max budget, currency, and quote status.

### LedgerEntry

Explains money, approval, proof, refund, and reservation events. Each row names the actor, entry type, optional amount, currency, summary, and timestamp.

### ProofArtifact

Points to reviewable evidence. Allowed proof kinds are `log`, `screenshot`, `download`, `receipt`, `link`, and `json`.

## CLI And API Parity

The CLI reads the same registry file as the Next API:

- CLI: `hii caps show`
- CLI validation: `hii caps validate`
- SDK status: `hii sdk status`
- API: `/api/capabilities`
- Context API: `/api/context`

The contract smoke check validates registry shape, enum values, proof kinds, job statuses, and static CLI/API registry parity without making external calls.
