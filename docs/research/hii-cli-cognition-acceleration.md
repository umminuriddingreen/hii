# HII CLI as a cognition-acceleration instrument

Research and implementation brief · 12 September 2026 · Recommendation, not a shipped capability

## Decision in one sentence

Make HII a quiet, source-grounded instrument for understanding and acting on a *selected digital environment*: one intent in, one useful answer or artifact out, one precise question only when blocked; retain scope, authority, observations, and proof underneath as CLI-owned state.

The shortest useful loop is **focus → ask/do → answer or artifact → inspect proof only if wanted**. “Focus” may be the current directory, an explicitly connected database, a selected file, a service, or a web page. The visible surface is not a transcript of the agent's execution. It is the result of the user's inquiry. A consequential action adds a visible preview/approval boundary; a failed or unverified action must not be visually indistinguishable from a completed one.

This uses HII's existing product contract, not a new product or a parallel control plane. ADR 004 makes the Rust CLI the runtime and receipt owner; ADR 005 makes the integrated spatial surface the wider human product. The current CLI's conversation view already suppresses tool lines and exposes `/proof` and activity views on demand. This brief targets what is still missing: coherent source selection, grounded answers across heterogeneous environments, and interaction that gets shorter as the user learns it. [Local: `docs/decisions/004-cli-first-hii-runtime.md`, `cli/src/conversation.rs`, `cli/src/acp.rs`.]

## Why this direction is credible—and where evidence is thin

Engelbart's augmentation thesis treated the human, language, artifacts, and procedures as one system for better comprehension and problem-solving, not as a machine producing longer prose. That supports measuring *human understanding and speed of useful action*, rather than number of agent steps or tokens.[1] Shneiderman's direct-manipulation principles favor continuous representation of the object of interest and fast, reversible, visible operations; in a CLI, the analogue is an explicit focus and short, inspectable transitions rather than permanent chrome.[2] Microsoft's empirically developed human-AI guidelines emphasize communicating capability limits, supporting correction, and keeping the user in control when the system is wrong.[3]

The difficulty is real. Spider 2.0's 632 enterprise SQL-workflow tasks involve broad schemas, several systems and queries, metadata search, and dialect knowledge; its reported baseline success was only 17.0% under its benchmark conditions. It is evidence against a generic “ask any database” promise, not a current HII accuracy estimate.[4] OSWorld's initial benchmark likewise showed a large human–agent gap for real desktop workflows (72.36% versus 12.24% in the published setup); that argues for typed system adapters and explicit verification before general GUI autonomy. Those numbers are historical benchmark results, not predictions for today's models or HII.[5]

There are useful adjacent systems, but none is HII's whole answer. Nushell demonstrates the ergonomic value of typed values flowing through terminal commands; HII should reuse that idea for evidence/results without replacing the user's shell.[6] SQLite and DuckDB expose real read-only connection modes, showing that a safe first database slice can be enforced below the model. SQLite's authorizer can additionally deny selected operations/columns while preparing statements.[7][8] MCP gives HII a connector protocol with schemas and tool results, but its own specification places input validation, access control, result validation, timeouts, audit, and sensitive-operation confirmation on implementers. A connector catalog is not authority or proof.[9] W3C PROV's entity–activity–agent distinction is a useful vocabulary for source lineage, though HII can keep its existing receipt model rather than adopting a new graph format.[10]

These sources support design principles and substrate choices. They do **not** establish that a minimal HII interface improves cognition; that requires measured, repeated human tasks below.

## The human interaction contract

The default screen should contain only the prompt, streamed answer/result, and a necessary question. No visible tool-call log, step counter, model trace, unsolicited “Next,” decorative status rail, or repeated source inventory. Source attribution appears compactly when the answer depends on a source or when two sources conflict. `/proof`, `/activity`, and diagnostics remain explicit escape hatches; backend logging and receipts continue without being sprayed into the conversation.

The same input line accepts natural language. Explicit targeting is an *optional disambiguator*, not a required command language:

```text
› Which customers have not ordered since June?
  18 customers. The three largest former accounts are …
  Source: orders.sqlite · read at 10:42 · 18 rows

› Compare that with the CRM export
  I found two CRM exports. Which one: August 30 or September 11?

› Restart the stalled indexer
  Restart indexer on Mac? Service: hii-indexer · current state: stopped
  Allow / Cancel
  Restarted. Health endpoint responded; receipt: …
```

Those are **target behaviors**, not a claim about the present CLI. A one-line source cue is helpful only if it conveys scope/freshness or can be opened into precise evidence; a decorative citation would be worse than none. Inline images, when present, should be evidence-bearing output (e.g. a chart or source thumbnail), never a mandatory second conversation pane. When not supported by the terminal, the same result must degrade to a meaningful text caption/link.

Default focus resolution should be deterministic and legible: an explicit user-selected source wins; then an unambiguous attached/foreground object; then the current workspace; otherwise ask a single source question. Never silently search every account, device, database, and browser tab. Preserve focus across related turns, display a short focus change when it actually changes the authority boundary, and let the user clear or retarget it. A model may suggest a source but must not silently grant itself a broader one.

Use **one question at a time** only if the choice changes scope, cost, destination, or irreversible consequence. If HII can safely gather more read-only evidence, it should do that first. Questions should contain the choices and their consequences, not “How would you like to proceed?” An answer resumes the *same* pending objective and receipt lineage; it must not launch an unrelated new run.

Answers should be “observed,” “inferred,” or “unavailable,” even if those labels are only shown on inspection. For a database answer, record exact connection identity, schema snapshot/fingerprint, bounded query and parameters, execution time, row count, truncation, and result hash. For a system answer, record host identity and freshness. For a web answer, record URL, retrieval time, and source excerpt anchors. For a comparison, link each claim to the observations that support it. A model's confident prose cannot turn stale cache or an unexecuted plan into an observation.

## One runtime pipeline, several environments

Do not add a second daemon, memory store, or “universal environment” abstraction. Extend the existing CLI capability/receipt path with a small **observation result contract** consumed by the current conversation loop and later projected on the canvas:

```text
user intent + focus
  → scope/authority check
  → bounded adapter observation (typed result + source identity + freshness)
  → synthesis or proposed action
  → read-back/verification where needed
  → concise response + durable receipt/provenance
```

The typed result should minimally carry: source ID and kind, host/device identity if relevant, observed-at time, operation and bounded arguments, value or artifact reference, completeness/truncation, sensitivity, errors, and evidence/receipt ID. These are fields to map into HII's existing objects/events/receipts—not a proposal to build a second canonical database. Prompt context should be assembled from compact metadata plus relevant rows/snippets, not a dump of whole databases or process lists.

Start with adapters whose ground truth is inspectable:

1. **Local SQLite, read-only.** Explicitly attach one DB under the workspace, list tables/schema within limits, query using a true read-only connection, deny non-SELECT operations and dangerous extension/function paths, impose wall-time/row/byte limits, and preserve exact SQL with bound parameters in the receipt. Do not use `immutable=1` on a live-changing database: SQLite warns it can yield incorrect results or corruption errors when the file changes.[7] SQL generation is a proposed program, not the answer; execute it, inspect result shape, and say when the question cannot be answered from available columns. Schema retrieval and dialect-aware correction matter more than a giant injected schema.[4]
2. **Local system observation.** Reuse current system-status/observe capabilities, but bind the answer to a live host identity, process/service name, observation time, and state reason. Never equate a saved daemon record with live liveness. Restart/stop/configure remain separate proposed actions with target preview, approval when required, and post-action read-back.
3. **Files and public web.** Reuse existing search/read and web-search/fetch capabilities. Make result provenance stable and bounded; source content is untrusted data, never instructions. A query spanning files and web should identify which claims came from each.
4. **Remote database/device and MCP.** Only after authenticated transport and scoped grants exist. The remote agent/server must enforce its own permissions; HII also enforces the user grant, validates schema/results, and records which device actually executed the operation. “Connected” or “listed” is not “live and executable.”[9]

Do **not** begin with free-form computer control or cross-system autonomous write flows. They combine the hardest grounding problem with the largest authority surface. The initial OSWorld result is a reason to demand execution-based evidence on each real app path, not to infer capability from a screenshot or tool manifest.[5]

## The first vertical slice to build

Pick one non-HII SQLite database that the owner permits the CLI to read; keep it local. The first task should be a real question whose answer requires schema discovery and a query, not a canned `SELECT 1`. The entire implementation can stay behind the current conversation input and CLI-owned capability manifest:

1. Register an explicit, revocable database focus with canonical path and read-only status. No automatic scan of the home directory.
2. Add bounded `db_inspect` and `db_query` capabilities (or equivalent names in the existing manifest). Their schemas define inputs/outputs; the executor, not the model prompt, enforces read-only mode, statement count, time, row and byte limits, and source identity.
3. Pass typed observations to the existing model loop. Generate one concise answer with source/freshness cue; when the query is ambiguous, ask one schema-specific question. Never print the query or tools in default conversation mode.
4. Attach operation, query parameters, result hash, row count, truncation, and failure cause to the existing receipt. `/proof` reveals them. A changed underlying database invalidates a previously cached answer or marks it historical.
5. Run the same task in the canvas projection only after the CLI behavior is credible; the canvas must consume the same focus, observation, and receipt IDs.

The present repo already has conversation visibility modes, tool manifests, MCP calls, local search, system observation, web fetch/search, receipts, and source-labelled context. It does **not** expose a dedicated typed SQL inspection/query capability in the inspected CLI manifest. The first slice is therefore a modest extension of the current loop, not a broad rewrite. A specific integration hazard is that the headless agent loop and interactive conversation loop do not automatically share behavior; any new capability needs parity or an explicit limitation. Another is that an `Ask` proposal exists in the durable vocabulary but the current action loop maps questions to `Message`; resumable questions require a loop change rather than copywriting alone. [Local: `cli/src/acp.rs`, `cli/src/agent.rs`, `cli/src/conversation.rs`.]

## Proof that this actually accelerates cognition

Recruit owner/developer tasks from three environments: a local database question, a live system diagnosis, and a file-plus-web comparison. Compare HII against each user's normal workflow (terminal/SQL client/browser), using the same data and access. Record, per task:

- elapsed time to a *correct, actionable* answer, not merely first token;
- factual correctness and evidence coverage, with a blind check against source data;
- wrong-scope reads, unsafe attempted operations, and unapproved writes (target: zero);
- number of user turns/clarifying questions, and whether a question was genuinely necessary;
- ability to detect stale/missing data and recover after a wrong answer;
- subjective mental effort and confidence, followed by whether confidence was calibrated to correctness.

Minimum first gate: five varied real tasks per environment, with a deterministic ground-truth check where possible. Do not claim a numerical productivity gain from a benchmark on generic SQL or desktop agents. The prototype passes only if it improves median time-to-correct-answer *without* reducing accuracy, provenance visibility on demand, or action safety. Keep failed questions as first-class evidence; they will tell us which scope and schema cues are missing.

## Immediate interaction change in this branch

The default conversation prompt now asks the model to lead with the result, avoid tool/process narration and routine next steps, ask one specific blocking question, and distinguish observation from inference. That is a small behavioral steering change, not proof that the future database/system contract is implemented. The existing UI default still keeps tool calls in backend logs/receipts and out of the normal conversation. No tests were run, by request. A future implementation should replace reliance on prompt wording with typed `Ask`/observation/result handling and narrow rendered-frame checks when the user permits verification.

## Sources

1. Doug Engelbart, [*Augmenting Human Intellect: A Conceptual Framework*](https://www.dougengelbart.org/content/view/138/) (1962). Primary text.
2. Ben Shneiderman, [author description of direct manipulation principles](https://www.cs.umd.edu/~ben/about.html) and [publication list](https://www.cs.umd.edu/~ben/publications.html). Primary author site.
3. Amershi et al., [*Guidelines for Human-AI Interaction*](https://www.microsoft.com/en-us/research/wp-content/uploads/2019/01/Guidelines-for-Human-AI-Interaction-camera-ready.pdf), CHI 2019. Primary research.
4. Lei et al., [*Spider 2.0: Evaluating Language Models on Real-World Enterprise Text-to-SQL Workflows*](https://arxiv.org/abs/2411.07763) (2024). Primary benchmark paper.
5. Xie et al., [*OSWorld: Benchmarking Multimodal Agents for Open-Ended Tasks in Real Computer Environments*](https://arxiv.org/abs/2404.07972) (2024). Primary benchmark paper.
6. Nushell, [structured pipelines](https://www.nushell.sh/book/pipelines.html) and [typed data fundamentals](https://www.nushell.sh/book/nu_fundamentals.html). Official documentation.
7. SQLite, [opening a database connection](https://www.sqlite.org/c3ref/open.html) and [compile-time authorization callbacks](https://www.sqlite.org/c3ref/set_authorizer.html). Official documentation.
8. DuckDB, [read-only CLI connections](https://duckdb.org/docs/current/clients/cli/overview). Official documentation.
9. Model Context Protocol, [tools specification, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools). Official specification. Version matters; revisit before implementation.
10. W3C, [PROV Overview](https://www.w3.org/TR/prov-overview/) (2013). Official working-group note.
