# NVIDIA runtime and reciprocal HII CLI handoff

Implementation commit: `6af731c03e25d4a53c59a5c9b9e9e62444b4843f`.

## Installed

- Windows release CLI: `C:\Users\ummin\dev\hii-nvidia-runtime\target\release\hii.exe`.
  The existing dirty `C:\Users\ummin\hii` checkout was preserved. The npm-directory
  PowerShell, cmd, and Git Bash launchers point at the updated installation;
  existing model URL, model alias and credential-file reference were retained.
  User `HII_ROOT` and `.hii/install-root` point at the isolated tested checkout.
  Open a new terminal to pick up the user environment change.
- Mac: clean canonical `/Users/ummi/hii` fast-forwarded to the same implementation.
  Its release CLI and `/Users/ummi/bin/hii` launcher were updated. MLX remains the
  Mac backend. The previous Mac binary and both platforms' launchers have backups.
- Windows enrolls `mac` through SSH alias `mac`; Mac enrolls `windows` through
  alias `hii-pc`. Existing registry entries and advertised capabilities remain.

## Changed source

- `aii/model-runtime/nvidia.mjs`, `aii/daemon/hiid.mjs`, and
  `config/native-model-profiles.json`: native/WSL engine discovery, bounded GPU
  profiles, ownership-safe lifecycle, telemetry, benchmark gates and task leases.
- `cli/src/context_budget.rs`, `model_task.rs`, `ollama.rs`, `config.rs`,
  `agent.rs`, and `conversation.rs`: provider token counts, bounded durable
  compaction, retrieval, restart continuity and task-boundary runtime selection.
- `cli/src/tool_artifacts.rs`, `mcp_client.rs`, `acp.rs`, and `tools.rs`:
  paginated redacted artifacts, on-demand MCP schemas and deadlock-safe output.
- `cli/src/remote_cli.rs`, `main.rs`, `presence.rs`, and `context.rs`:
  receipted cross-platform CLI calls, live Windows process detection and
  portable path handling.
- `scripts/hii-cli-install.mjs`, `hii-launcher.ps1`, `hii-launcher.sh`, and
  the two new smoke/test scripts: reversible installation and literal argv.
- `docs/hii-nvidia-runtime.md`: commands, contracts and explicit limitations.

## Verified

- Windows CLI: 542 tests passed, one live-search test ignored.
- Mac CLI: 566 tests passed, one live-search test ignored.
- NVIDIA fixture suite: 28 checks passed; launcher suite: three tests passed.
- Optimized release builds passed on both platforms. Windows required `-j 2`
  after a compiler access violation in the initial parallel build.
- Installed Windows CLI returned `HII_RUNTIME_OK` using the existing authenticated
  local Qwen connection. Receipt: `01a0b213-617f-7ef3-a546-70f26ff9e974`.
- Installed Mac CLI returned `HII_MAC_RUNTIME_OK` using local MLX.
  Receipt: `01a0b215-ea61-7d20-92c6-f30340ce19b4`.
- Windows agent created a JSON artifact, passed its operator-specified Node check,
  and completed in three steps. Receipt: `01a0b215-f9a9-7cf1-a274-c8eed5640309`.
  Fixture: `C:\Users\ummin\dev\hii-runtime-proof-20260917\proof.json`.
- Windows to installed Mac CLI version and model status calls completed.
  Remote receipts: `87df4495-b9fe-4663-a478-6a337f71d4f6` and
  `2e45c981-ef01-4a31-ab6e-c81b36f275e1`.

## Not verified / requires operator action

- Mac to Windows failed SSH signing: Windows accepted the existing public key,
  but macOS Keychain reported `User interaction is not allowed`. No authentication
  settings or private keys were changed. Unlock the Mac and run
  `ssh hii-pc whoami` interactively, then retry:
  `hii on windows cli --json -- runner model doctor --json`.
  Failed remote receipt: `de425795-a97a-44a3-a4d2-fdb0bb386a0b`.
- WSL CUDA/vLLM engines are not installed. A large dependency installation needs
  the user's approval; no weights, drivers or large packages were downloaded.
- A tool policy rejection prevented the proposed runtime-adoption/benchmark
  command. Existing runtime configuration was preserved. No throughput gain or
  native-versus-WSL winner is claimed; the installed profiles are candidates,
  not promoted benchmark winners.
- GPU memory was tight (about 750 MiB free at the final live diagnostic).
  No other application was closed and no service was forcibly replaced.
- No canvas UI, desktop package or web deployment was changed by this CLI work.

## Rollback boundaries

Launcher backups are alongside their originals. The Mac binary backup is
`/Users/ummi/hii/target/release/hii.before-nvidia-6af731c0`. Windows retains its
original checkout and release binary; its previous user `HII_ROOT` was
`C:\Users\ummin\hii`. Roll back source/launchers separately from user data;
do not reset dirty worktrees or restore databases as part of source rollback.
