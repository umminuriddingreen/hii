# HII native model runner

`hii-native-runner` is HII's owned local-inference service. On Apple Silicon it
supervises a private, pinned MLX-VLM engine; on other supported hardware the
portable mistral.rs path remains available. Users interact with HII,
not either engine directly. The HII layer owns:

- loopback-only serving on `127.0.0.1:11435`;
- model storage rooted at `~/.hii/models`, never Ollama's private blob layout;
- an atomic runtime manifest with source, revision, license/integrity state;
- an HII metrics discovery endpoint at `/v1/hii/metrics`;
- lifecycle ownership through `runtime/daemon/hiid.mjs`.

The engine's OpenAI-compatible loopback surface provides `/health`,
`/v1/models`, and streaming `/v1/chat/completions`. Keeping integration at this
protocol boundary makes upstream updates reviewable and engines replaceable.

## Consumer commands

```sh
hii runner model doctor
npm run runner:build
hii runner model start
hii runner model status
hii runner model bench
hii runner model stop
```

Starting a model is the explicit acquisition boundary. HII does not download
weights during install or `doctor`. Hosted Codex and Claude use also remains an
explicit action; local `auto` routing does not silently transmit prompts.

## Backend boundary

On Apple Silicon the default engine is MLX-VLM in an HII-managed environment at
`~/.hii/runtimes/mlx`; the hardware profile selects the model. HII prepares the
pinned engine only after the operator accepts first-run setup or explicitly
runs `hii runner model start`. Ollama and LM Studio are compatibility adapters,
never implicit dependencies. Hosted Codex and Claude remain explicit login and
transmission routes.

The Rust runner remains the lifecycle and policy boundary while inference runs
in a separate long-lived worker. Its interactive defaults favor one foreground
user: automatic prefix caching is enabled with a bounded 256-block pool,
prefill uses 2048-token steps, concurrent decode is limited to one sequence,
and the unused vision-feature cache is kept small. These are overrideable:

```sh
hii runner model start --prefill-step-size 4096 --max-num-seqs 1
hii runner model start --max-kv-size 8192 --kv-bits 8
hii runner model start --draft-model /path/to/already-acquired-drafter
hii runner model start --no-apc
```

KV quantization and speculative decoding are opt-in because either can reduce
throughput for an incompatible model or short context. Supplying a draft model
never authorizes HII to acquire it automatically.
