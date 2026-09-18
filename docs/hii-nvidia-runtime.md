# HII NVIDIA runtime and cross-device CLI

HII supports native Windows CUDA and explicitly prepared WSL CUDA/vLLM engines
through the existing `hii runner model` surface. The Mac MLX route is unchanged.
GPU capacity is separate from task difficulty; profiles live in
`config/native-model-profiles.json` and are candidates until measured.

## Inspect and select

```text
hii runner model doctor --json
hii runner model status --json
hii runner model start --backend native-cuda --profile adaptive --dry-run
hii runner model start --backend wsl-cuda --profile shared-gpu --dry-run
hii runner model bench --suite quick
hii runner model bench --suite quick --baseline /path/to/previous-suite.json
```

Native discovery supports `llama-server` and `llama serve`. Existing GGUF files
are referenced in place through `HII_MODEL_CONFIG` (Windows default:
`C:\models\models.ini`). WSL uses the default installed distribution, overridable
with `HII_WSL_DISTRO`; `HII_WSL_LLAMA_SERVER_BIN` selects a prepared Linux binary.
vLLM requires an already installed private environment and compatible Linux model
directory via `HII_WSL_VLLM_BIN` and `HII_VLLM_MODEL_PATH`. No command silently
installs packages, copies weights, or upgrades the NVIDIA driver.

An existing authenticated endpoint can be explicitly adopted with `start
--endpoint URL --api-key-file PATH --model ALIAS`. This records references in
`~/.hii/config/inference.json`; it never takes ownership of that process. `stop`
refuses to signal external services. Managed stops check process birth identity,
including Linux boot ID and start ticks for WSL. No distro-wide shutdown is used.

Explicit environment settings take precedence. Credentials remain in their
existing file and are sent only to the selected endpoint. Saved connection
credentials are never reused for a different endpoint override.

## Adaptation and evidence

### Isolated WSL CUDA installation

The reproducible installer is `scripts/hii-wsl-cuda-install.py`. It uses the
official NVIDIA CUDA 12.9.1 redistributables (nvcc, cudart, CCCL and cuBLAS),
checks each archive's SHA-256, and builds llama.cpp revision `6a1a922d2`
(`b10819`) for the RTX 5080's SM 120 architecture. It does not install a Linux
NVIDIA driver, download weights, or replace system CUDA. CMake, Ninja and GCC
must already be available in Ubuntu. Ask before the approximately 970 MiB SDK
download and several GiB installation.

Clone the pinned source into `<prefix>/llama.cpp`, then run in WSL:

```text
python3 scripts/hii-wsl-cuda-install.py --prefix /absolute/isolated/prefix --jobs 4
```

For WSL without working internet, run the script's `--download-only` mode on
Windows, clone the pinned source through Windows, and pass the shared download
directory with `--cache /mnt/c/.../downloads` during the Linux build. Configure
`HII_WSL_LLAMA_SERVER_BIN` to the resulting `llama.cpp/build-hii/bin/llama-server`.
Doctor uses `/usr/lib/wsl/lib/nvidia-smi`, not a login-shell PATH assumption.

`hii-cuda-benchmark.py` measures the same local weights on native and WSL CUDA,
with three repetitions each of prompt processing, generation, and mixed work.
`hii-cuda-server-smoke.py` separately verifies JSON, long-context retrieval and
tool-call correctness in a temporary loopback server; it stops only its own
child. Neither proof script changes the production endpoint or selects a winner.
Run them serially after unloading an idle serving model, never alongside it.

WSL engine availability is separate from Windows-to-WSL endpoint connectivity.
Do not promote WSL if its networking is unavailable. Do not restart a distro
containing another active session without the operator's approval.

For this machine's measured results and native context tradeoff, see
`docs/records/2026-09-18-wsl-cuda-tuning.md`.

Fast, Deep, and Shared GPU profiles bound context, KV precision and batch sizes.
Adaptive profiles choose at task boundaries; active tasks keep one model. A
per-runtime lease coordinates HII CLI tasks and detects stale owners. Other
applications remain user-controlled. GPU memory advice reports aggregate
measurements; unavailable per-process attribution is explicitly unknown.

Automatic changes require an HII-owned idle engine, adequate headroom, a cooldown,
and matching baseline/candidate benchmark evidence. Evidence pairs are configured
under `~/.hii/config/nvidia-profile-evidence.json`, keyed by profile with
`baseline` and `candidate` artifact paths. All workload correctness checks must
pass, at least one workload must improve wall time by 15%, and none may regress
by more than 5%. Missing evidence produces advice and preserves the active engine.
These are local measurements, not universal model rankings.

The quick suite repeats short structured-output, long-context retrieval and
tool-schema workloads. It distinguishes time to first token, whole-request
latency, and server-reported generation rate. It does not infer GPU-only decode
speed from tokens divided by total wall time or label unknown cache state cold.

## Context and tools

Conversations and agent loops share input/output budgets. Supported local text
backends use authenticated template/tokenization endpoints; unsupported backends
and images expose conservative estimates. `HII_MODEL_CONTEXT_TOKENS`,
`HII_MODEL_OUTPUT_TOKENS`, and `HII_MODEL_IMAGE_TOKENS` allow explicit verified
capacity settings.

Compaction preserves operator instructions, runtime authority, recent complete
tool exchanges, and references to durable redacted checkpoints. It uses bounded
extractive checkpoints, not an unverified claim of lossless semantic compression.
Checkpoints are persisted before live context changes and can be resumed after
restart. Required context that cannot fit produces a recoverable error.

MCP schemas load through `mcp_search` and `mcp_schema`. Large results are stored
as workspace-scoped artifacts and retrieved in pages with `artifact_read`;
`checkpoint_read` retrieves older context. Discovery never grants execution
authority. Shell output drains continuously so a full pipe cannot deadlock a run.

## Calls between installed CLIs

```text
hii systems enroll mac --host mac --os macos --transport ssh --cap hii.cli
hii systems enroll windows --host hii-pc --os windows --transport ssh --cap hii.cli
hii on mac cli --json -- --version
hii on windows cli --json -- runner model doctor --json
hii on mac cli --allow-write --timeout 300 -- runner model start
```

Use the existing SSH aliases and approved host keys. Remote invocation targets
`~/bin/hii` on Mac/Linux and `%APPDATA%\npm\hii.ps1` on Windows. Arguments are
passed literally, not concatenated as executable user shell text. Read-only
inspection has a narrow allowlist; other CLI calls require `--allow-write` for
that invocation and retain the destination CLI's authority checks. Results and
exit status receive a local receipt. A lost connection or timeout has an unknown
remote outcome and must be inspected before retrying a write.

`node scripts/hii-cli-install.mjs --launcher-only --set-root` installs the
platform launcher and records its checkout without requiring a browser rebuild.
Existing launchers and installation roots receive backups. A custom Windows
wrapper must be preserved or explicitly replaced after migrating its settings.

## Verification boundary

Unit and fixture checks cannot establish live WSL speed, multi-GPU performance,
creative-app coordination, or artifact quality. Report those separately from
actual native/Mac inference and reciprocal CLI execution receipts. Use existing
bounded capabilities for code, creation, and research workflows; no new broad
filesystem or network authority is implied by this runtime upgrade.
