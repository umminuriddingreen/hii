# HII Compute

An Apache-2.0 compute component owned by HII. A coordinator holds bounded
inference jobs; contributor workers pull matching jobs and run them through
their machine's **HII native model runtime**. No Ollama dependency, platform
account, paid API, token billing, or automatic downloads.

Windows NVIDIA and Apple Silicon (including M3 Max) use the same worker and
protocol. CUDA / Metal / MLX remain underneath HII's existing model runtime.
This distributes independent jobs across machines; it does not combine their
VRAM or split one model between GPUs. Version 0.1 supports text inference only.

## Build

From the repository root, with Rust installed:

```sh
cargo build -p hii-cli --bin hii
cargo build -p hii-compute
```

`target/debug/hii compute ...` is the integrated command.
`target/debug/hii-compute ...` is the independently open-source executable with
the same subcommands (Windows binaries end in `.exe`). The HII CLI and native
runner keep their existing licenses; only this new component is Apache-2.0.
See [LICENSE](LICENSE). A future public distribution still needs a review of
the complete runtime and model licenses.

## Start a coordinator

Generate two distinct random secrets. Never use the illustrative placeholders:

```powershell
$env:HII_COMPUTE_CLIENT_TOKEN = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
$env:HII_COMPUTE_WORKER_TOKEN = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
.\target\debug\hii.exe compute serve
```

On macOS (zsh/bash):

```sh
export HII_COMPUTE_CLIENT_TOKEN="$(openssl rand -hex 32)"
export HII_COMPUTE_WORKER_TOKEN="$(openssl rand -hex 32)"
./target/debug/hii compute serve
```

Keep the client credential on machines allowed to submit/read all jobs. Give
the worker credential only to trusted contributors; it allows claiming jobs,
reading their prompts, and returning results. Transfer credentials privately.
All contributors in this version share one worker credential. Stop the queue,
replace that credential, and restart to revoke all contributors. Per-device
identity and selective revocation are future work.

The queue defaults to `~/.hii/compute/queue.json`. An exclusive lock prevents
two coordinators from using the same file. Atomic file replacement stores job
state and returned results. Running leases are reset after restart. Keep this
directory private: prompts and results are retained in plaintext. Capacity is
10,000 retained jobs; archive the stopped queue and choose a fresh `--state`
file when full. Only one coordinator is supported per queue.

## Contribute Windows RTX or M3 Max compute

First use the installed HII model commands to start its native model runtime:

```sh
hii model status --json
hii model start
```

Use the endpoint actually reported by HII; examples below are illustrative.
`/v1/models` must succeed before the worker advertises itself. A model manager
`/health` response alone does not prove inference is available. The worker
never starts/stops another runtime or downloads weights.

Windows, with the coordinator's worker credential in this terminal:

```powershell
.\target\debug\hii.exe compute worker --name windows-5080 --runtime http://127.0.0.1:11436
```

M3 Max, using the **same** coordinator worker credential:

```sh
export HII_COMPUTE_WORKER_TOKEN='<privately supplied worker credential>'
./target/debug/hii compute worker --name m3-max \
  --runtime http://127.0.0.1:11435 \
  --coordinator https://compute.example.org
```

The native runtime stays on loopback. If it requires an API token, set
`HII_COMPUTE_RUNTIME_TOKEN` in the worker environment. The wire format is HII's
existing native `/v1/models` and `/v1/chat/completions` contract. Backend and GPU
identity are not attested by this component; platform/model advertisements are
worker-reported. A Windows-to-M3-Max native inference acceptance run passed on
2026-10-12; see the [verification record](../../docs/records/2026-10-12-hii-compute-node.md).

For two machines on a trusted private network, explicitly bind the coordinator
to its private interface with `serve --listen <private-ip>:6138`. Use HTTPS via
a configured TLS proxy, or pass `--allow-insecure-lan` with an HTTP coordinator
URL on each client/worker. That option sends tokens and prompts without TLS;
use it only on a trusted encrypted fabric. No public listener, firewall rule,
tunnel, account, or service installation is created automatically.

## Submit and retrieve work

```sh
hii compute nodes
hii compute submit --model '<model advertised by nodes>' --prompt 'Explain GPU job scheduling.' --max-tokens 128
hii compute job '<returned job id>'
```

For a remote queue, add `--coordinator https://compute.example.org` to each
command. Each idle worker refreshes its model catalog and claims at most one
matching job every two seconds. Jobs are bounded to 32 KiB prompts and 4096
output tokens. A 180-second lease prevents concurrent valid ownership; expired
leases may be reassigned. Inference has a 120-second request timeout. Execution
is at-least-once after crashes/timeouts, so repeated computation is possible.
Stale completions cannot overwrite reassigned or completed work.

`job` returns the worker name, request, timestamps, status, error, and native
model output. The receipt establishes that a credentialed worker returned a
result; it does not establish model correctness, GPU execution, or hardware
identity. Nodes disappear after 30 seconds without a poll unless they still
hold an active job lease. Failed native runtime requests are surfaced as
failures; there is no hosted or compatibility-provider fallback.

## Checks

```sh
cargo test -p hii-compute
```

Tests cover role separation, model matching, bounded requests, origin checks,
persistence, restart/lease recovery, stale-result rejection, and a real HTTP
round trip through a **mock** native model server. They do not prove physical
CUDA or Metal inference. Software is free; hardware, electricity, internet,
and model-license obligations remain with contributors.

Smoke the integrated binary with a disposable, authenticated local queue:

```sh
node crates/hii-compute/smoke.mjs ./target/debug/hii
```

For Tailscale SSH, an SSH reverse tunnel can connect the remote worker to the
loopback coordinator without binding a network listener. For example, forward
a remote loopback port to the coordinator with
`ssh -R 127.0.0.1:16138:127.0.0.1:6138 <mac-host>`, then use
`--coordinator http://127.0.0.1:16138` on that Mac. Only the tunnel crosses the
network; the native runtime and coordinator remain loopback services.
