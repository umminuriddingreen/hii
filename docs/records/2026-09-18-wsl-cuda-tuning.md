# WSL CUDA installation and NVIDIA tuning

## Installed and verified

- CUDA 12.9.1 SDK is isolated under
  `/home/ummin/.hii/runtimes/wsl-cuda-12.9.1/cuda` in Ubuntu-24.04.
  Four NVIDIA archives were SHA-256 verified; download size approximately
  970 MiB. SDK, extracted packages and build occupy approximately 5.1 GiB.
- llama.cpp `b10819`, commit `6a1a922d269908a29cbd4b49c27e6a8e7fd10fae`,
  compiled with GCC 13.3 and native RTX 5080 SM 120a kernels. This matches the
  native Windows engine revision. No driver or model weights changed.
- CMake, Ninja and five small supporting Ubuntu packages were installed.
  WSL had no working network interface or DNS file, so downloads used Windows;
  existing WSL sessions were not restarted. A stale optional libcurl package
  URL failed; it was not installed and the loopback-only build does not need it.
- HII doctor now detects WSL CUDA without relying on a login-shell PATH.
  The WSL binary/distro and current native binary are saved as per-user discovery
  environment variables. Start a fresh Windows terminal to inherit them.
- Five installer/proof safety tests pass on Windows and WSL; 28 NVIDIA runtime
  checks pass. WSL's temporary authenticated server passed exact JSON,
  7,620-token marker retrieval and tool-call correctness checks, then exited.

## Native versus WSL: same-weight comparison

Model: existing `Qwen3.5-9B-Q4_K_M.gguf`, 5,627,044,256 bytes, referenced in
place through the Windows mount. Both engines used the same revision, batch
512, microbatch 128, 16 CPU threads, GPU layers 999, Flash Attention and Q4 KV.
Each measurement had three repetitions and the benchmark's normal warmup.
Model loading is excluded; these are microbenchmarks, not agent-quality tests.

| Workload | Native Windows tokens/s | WSL tokens/s | WSL difference |
| --- | ---: | ---: | ---: |
| Prompt processing, 512 tokens | 4,398.9 | 4,426.8 | +0.64% |
| Generation, 128 tokens | 122.1 | 121.2 | -0.70% |
| Mixed 4,096 prompt + 128 generated | 2,219.2 | 2,177.1 | -1.89% |

These differences are small and within the observed sample variability.
WSL did not demonstrate a reason to replace native Windows for this workload.
This result does not rank vLLM, different models, or every batch/concurrency mix.

Local receipts under `C:\Users\ummin\.hii\benchmarks\20260918-cuda`:

- `native-9b-512-128.json`
- `wsl-9b-512-128.json`
- `wsl-server-9b.json` and its local diagnostic log

## 35B serving profile experiments

The original native profile forced every layer onto the GPU, with 65,536 context,
batch 2,048 and microbatch 512. The initial six-request HII suite passed but
the first 7,620-token retrieval request took 112.5 seconds and generation
measured approximately 8–13 tokens/s on the short workload samples.
Receipt: `.hii/daemon/nvidia-suite-1789703214928.json`.

A 16,384-context, batch-512/microbatch-128 candidate initially passed all checks,
with first long-context latency 8.8 seconds and generation approximately
75–129 tokens/s. Receipts: `nvidia-suite-1789703312473.json` and the subsequent
warm suite `nvidia-suite-1789703325612.json`. However, a fresh reload did not
reproduce that speed. This candidate is not a stable performance claim.

A 32,768-context all-GPU candidate timed out on the long request. A standalone
35B all-GPU stress benchmark also showed severe memory pressure and was stopped;
only its exact benchmark child was signaled. These failed/aborted measurements
must not be included as successful backend comparisons. Other GPU applications
were left running. Final tuning results follow.

### Final applied native profile

The same 35B model now uses **32,768 context, batch 512, microbatch 128,
eight CPU-resident MoE expert layers, 16 generation threads and 24 batch
threads**. Remaining layers/attention stay GPU-backed, with Flash Attention
and Q4 KV unchanged. All weights remain the same: this is memory placement,
not reducing the model or changing its quantization. The working context is
half the original 64K and matches HII's existing 32K client budget.

Automatic fitting alone was insufficient under the observed Windows memory
pressure. Explicitly moving eight expert layers to RAM left approximately
1.9 GiB of GPU headroom and reproduced the improvement across fresh reloads.
An eight-generation-thread trial did not improve on 16 threads, so 16 remains.

- First six-check suite: `nvidia-suite-1789704409861.json`, all passed;
  long retrieval 11.6 s and sample generation 46–53 tokens/s.
- Fresh reload / final six-check suite: `nvidia-suite-1789704544765.json`,
  all passed; long retrieval 12.0 s and sample generation 43–52 tokens/s.
- Original long retrieval: 112.5 s. This is approximately 9.3x lower latency
  on the same retrieval payload, with the context-capacity tradeoff above.
- Samples are short, machine-local and dependent on other GPU applications;
  this is not a universal maximum-throughput or long-duration stability claim.
- Installed Windows HII completed a three-step agent task that wrote JSON and
  passed the operator's Node acceptance check. Receipt:
  `.hii/runs/cli/01a0b2b4-c132-7860-829c-96ceba59b5a8/receipt.json`.

The rail remains authenticated at its existing address, and the local bridge
and Mac model access remain unchanged. Other model presets were not modified.

Preset backup: `C:\models\models.ini.before-hii-wsl-tuning-20260918`.
No credential values are stored in these source records or benchmark receipts.

## Cross-machine proof and boundaries

After the operator unlocked the existing Mac SSH key, the installed Mac CLI
successfully invoked the installed Windows CLI. Receipt on Mac:
`/Users/ummi/.hii/runs/remote/5f6935a7-6e0b-4bd0-a14c-aa93b38fff7d.json`.
The previous Windows-to-Mac proof remains in the 2026-09-17 handoff.
At the final recheck, Windows-to-Mac passed again (receipt
`f9648848-62ca-4082-8277-e2b9d6004d04`), but reverse SSH authentication had become
unavailable again. Windows still accepted the existing public key; signing
could not complete noninteractively. The later failed Mac receipt is
`2e02efd5-3c1c-4df3-9ecf-ce087d1740cd`. The successful unlock-time proof is not
a claim of persistent unattended authentication. No authentication weakening
or private-key change was attempted.

Windows-to-WSL loopback connectivity failed independently of the CUDA build.
The active WSL Codex session was preserved; a distro restart was not assumed.
Native Windows remains the production endpoint, so this does not block its use.
vLLM, model downloads, multi-GPU performance and creative-app coordination were
not installed or claimed by this pass.

A tool policy blocked the proposed HII client `inference.json` update. No
alternate write was used to bypass it. The operator was asked to perform the
command, then asked to hold it while testing a profile compatible with the
existing 32K client budget. The final profile matches that budget, so the earlier
16K client-setting command is **not needed**. No policy-blocked configuration
write was bypassed.

## Source and configuration changes

- `aii/model-runtime/nvidia.mjs` and its smoke test: correct WSL GPU discovery.
- Four `scripts/hii-cuda-*.py` / `hii-wsl-cuda-install.py` files: reproducible
  installation, controlled microbenchmark, correctness proof and safety tests.
- `.gitignore`: exclude only generated script bytecode.
- `docs/hii-nvidia-runtime.md` and this record: operational instructions/results.
- Local `C:\models\models.ini`: the final 35B serving profile above, backed up
  before modification. Per-user environment records the installed engine paths.

Unrelated CLI/TUI and release-installer edits in the Windows worktree were
preserved and were not included in this tuning commit. No web deployment,
desktop rebuild, model download or Mac MLX change is part of this pass.
