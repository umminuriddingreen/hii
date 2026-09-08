# Windows Local Chat in HII

Date: 2026-09-05

## Source and Scope

This integration starts from the current Mac HII commit
`463c854d7f277e17c9752aa758b0a16ba94c2e7f`, in the isolated Windows worktree
`C:\Users\ummin\dev\hii-windows` on branch `codex/windows-local-chat`.
The Mac product is the source for HII's existing canvas and desktop shell.
The previously verified Local Dialog vertical slice supplies the local chat
core and presentation patterns. Its standalone repository is not a runtime
dependency of HII.

HII remains one application. Canvas is still the default surface. A native
Canvas/Chat switch opens HII Chat without replacing or restyling the canvas.
Both surfaces remain mounted after Chat first opens, preserving canvas state
and chat drafts. Chat input events stop before the canvas's global keyboard,
paste and pointer-move handlers. Chat transcripts never enter account canvas
synchronization.

This slice adds text conversation with a local OpenAI-compatible HTTP provider,
first exercised with llama.cpp llama-server. It adds no tools, browser actions,
RAG, embeddings, cloud provider fallback, cloud sync, or model downloads.
Existing HII agent and account features retain their separate contracts.

## Runtime Ownership

React renders snapshots and dispatches typed commands. The shared `hii-chat`
Rust crate owns conversations, structured message parts, message parent IDs,
generation orchestration, checkpoints, settings and runtime supervision. It
has no Tauri dependency and is usable by the Rust CLI.

The first provider implements `InferenceProvider` against loopback HTTP. It
disables proxies and redirects, parses provider SSE, and separates response
text from reasoning parts. Tool-call deltas are rejected. Runtime ownership
distinguishes an external server from an app-managed llama-server process;
the app only terminates processes it owns. Windows Job Object ownership ties
the managed process to the app's lifetime.

The streaming path is:

```text
llama-server SSE -> Rust provider -> conversation service -> SQLite checkpoint
                -> hii://chat-updated Tauri event -> React presentation
```

Updates contain full authoritative conversation snapshots with monotonically
increasing revisions. React subscribes before initial loading and ignores
stale snapshots. Streaming checkpoints occur approximately every 250 ms;
visible emitted text has already been committed. Final output and generation
status commit before terminal snapshots are published. Startup recovery marks
unfinished generations interrupted and retains their last committed parts.

## Durable Data

HII Chat shares `~/.hii/hii.db`, or the file named by `HII_DB_PATH`. The runtime
root defaults to `~/.hii` and can be overridden by `HII_RUNTIME_DIR`.

Chat owns only its namespaced tables:

- `chat_conversations`
- `chat_messages`
- `chat_message_parts`
- `chat_generations`
- `chat_settings`
- `chat_schema_migrations`

Existing HII tables and migration markers remain independently owned. Chat
does not change SQLite `user_version`. WAL, foreign keys, bounded busy waits
and atomic transactions protect durable writes. A snapshot reads its revision,
messages, parts and generations in one read transaction so concurrent CLI
inspection cannot combine records from different revisions.

Chat's exclusive writer/recovery lock is derived from the canonical database
path, with suffix `.chat-owner.lockfile`. Two different runtime roots pointing
to one `HII_DB_PATH` cannot both recover or generate against that database.
Read-only CLI inspection remains available while desktop Chat owns it.
Runtime logs stay under the selected HII runtime root.

## CLI Contract

The `chat` command family uses split routing. Only the following verbs belong
to the new native Rust implementation:

```powershell
.\target\debug\hii.exe chat list
.\target\debug\hii.exe chat show CONVERSATION_ID
.\target\debug\hii.exe chat new
.\target\debug\hii.exe chat settings
.\target\debug\hii.exe chat settings --endpoint http://127.0.0.1:18080/v1 --model-id local
.\target\debug\hii.exe chat send --conversation CONVERSATION_ID "Hello"
```

Bare `hii chat`, `hii chat open`, existing flags and other legacy verbs keep
their delegated behavior. Native settings support `--llama-server`, `--gguf`
and `--managed true` for a managed local server. Mutating chat commands require
exclusive chat ownership, so run them while the desktop app is closed. `list`,
`show` and settings inspection can read the shared database while it is open.

## Changed File Groups

| Group | Purpose |
| --- | --- |
| `crates/hii-chat/`, root Cargo workspace and lockfile | Shared Rust services, provider, schema, runtime ownership and focused tests |
| `cli/src/local_chat.rs`, `cli/src/main.rs`, `cli/src/route.rs`, CLI manifest | Native chat verbs with preserved legacy routing |
| `cli/build.rs` | Windows MSVC stack allocation for the existing large CLI dispatcher |
| `src-tauri/src/chat.rs`, `src-tauri/src/lib.rs`, Tauri manifest and lockfile | Thin IPC adapter, application-owned chat state, events and shutdown |
| `components/desktop/chat/`, `lib/desktop/chat.ts`, `lib/desktop/chat-types.ts` | Embedded chat presentation, runtime controls and typed bridge |
| `components/desktop/DesktopHiiAccess.tsx` and its CSS module | Surface switching, canvas preservation and device-neutral labels |
| `src-tauri/src/account_sync.rs` | Isolated native acceptance account configuration |
| `scripts/hii-native-chat-acceptance.mjs` | Native Windows WebView2 acceptance harness and evidence artifacts |
| `docs/records/2026-09-05-windows-local-chat.md` | Integration decisions, verification status and remaining work |

## Verification

Focused commands for this integration:

```powershell
npm run check
cargo test -p hii-chat
cargo test -p hii-cli route::tests::chat
cargo build -p hii-cli
cargo check --manifest-path src-tauri/Cargo.toml
git diff --check
```

Native acceptance result: **PASSED** on Windows with installed llama.cpp b10620
and Qwen3.8-27B-UD-IQ3_S.gguf. Evidence:
`artifacts/native-chat-acceptance-1788633115614/report.json` and five screenshots.
The 112-second run observed 257 committed partial UI updates, identical SQLite
parts, Canvas/Chat preservation, normal restart, exact-generation crash recovery,
owned runtime cleanup, unchanged graph schemas and a passing integrity check.
No WebView JavaScript errors or attempted cloud requests were recorded.

`npm run check`, desktop static build, native Windows debug build, 12 chat tests,
the two CLI chat routing tests, and chat Clippy with warnings denied passed.
The broader `npm run build` web export compiled but failed on the untouched
`/opengraph-image` route with `TypeError: Invalid URL` in Next's Windows OG loader.
No website deployment was made. This is a local Windows preview, not a signed
installer or a claim of full HII Windows feature parity.

Start with `powershell -NoProfile -File scripts/start-windows-chat.ps1`.
The launcher initializes settings only for a fresh preview database, uses the
installed local model, and preserves subsequent conversations at
`%LOCALAPPDATA%/HII/windows-local-chat-preview/hii.db`. It does not import or sync
Mac conversations. Select Chat, then Local runtime > Start runtime.

The acceptance script requires existing absolute paths to the built desktop
executable, CLI, llama-server and GGUF, plus Playwright and a Node release with
`node:sqlite`. It does not download models or replace the user's data.

```powershell
$env:HII_DESKTOP_EXE = 'C:\Users\ummin\dev\hii-windows\src-tauri\target\debug\hii.exe'
$env:HII_CLI_BIN = 'C:\Users\ummin\dev\hii-windows\target\debug\hii.exe'
$env:LLAMA_SERVER_EXE = 'C:\path\to\llama-server.exe'
$env:LLAMA_MODEL_PATH = 'C:\path\to\existing-model.gguf'
node scripts/hii-native-chat-acceptance.mjs
```

The two `C:\path\to` entries are placeholders for already installed assets.
Optional `HII_PLAYWRIGHT_MODULE` names an existing Playwright module if needed.
`HII_CHAT_TEST_PORT` defaults to 18080 and `HII_CHAT_DEBUG_PORT` to 9223; both
must be free. The harness creates a unique `artifacts/native-chat-acceptance-*`
directory and isolates `HII_RUNTIME_DIR`, `HII_DB_PATH`, `HII_UI_DIR`, account
configuration and WebView2 profile there. WebView2 debugging is a test-only
launch option. The script records checks, errors, screenshots and timing.

Required native proof is launch -> select Chat -> create conversation -> send
to real local llama.cpp -> observe streaming -> inspect SQLite -> close and
restart -> recover the same conversation and response. Cancellation, forced
process interruption, canvas preservation and runtime ownership need their
own recorded checks before being described as verified.

The broader CLI test run reported **472 passed and 6 failed**. The failures
concern agent artifact path separators, context-board source paths, an
`mcp_client` missing-path assumption, presence process detection, concurrent
JSON replacement in `store` on Windows, and a tools test expecting `python3`.
Those failing modules were untouched by this integration and remain Windows
portability risks. A pristine pre-change baseline was not tested; this record
does not claim that all six failures were proven to occur on the baseline.
The full HII CLI suite is therefore not green even if local chat acceptance
passes.

## After the Vertical Slice

Only after native acceptance passes, prioritize conversation rename/archive/
search, branch navigation and regeneration, polished Markdown/code rendering,
context budgeting and model selection. Then add the companion window and
Windows shortcut behavior over the same Rust conversation state. Local file
attachments and richer model management need their own service tests and
end-to-end proof. Fix the identified Windows portability issues before claiming
general HII Windows parity. Tools, browser automation, RAG and sync remain
outside this slice and require an explicit subsequent scope.

## Receipt Procedure

Receipt syntax was inspected locally in `scripts/hii-cli.mjs` and
`aii/skills/registry.mjs`; writing a receipt is not part of this document's
creation. After final validation, the implementation thread can record one:

```powershell
node scripts/hii-cli.mjs skill report --file artifacts\windows-local-chat-receipt.json
```

The JSON object requires `agent.id` and `summary`. Use `verification.status`
(`verified`, `partial`, or `unverified`), `verification.checks`,
`verification.proof`, `risk.tier`, `risk.permissions` and `risk.sideEffects` to
record precise evidence and limits. Include `repeatable: true` and `skillHint`
in the JSON to create a draft skill candidate. With `--file`, separate CLI
receipt flags do not augment the file; put all receipt fields in the object.
Registration is separate from reporting and remains operator-reviewed.
