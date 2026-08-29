# HII native model runner

`hii-native-runner` is HII's owned local-inference service. On Apple Silicon it
supervises a private, pinned MLX-VLM engine; on other supported hardware the
portable mistral.rs path remains available. Users interact with HII Native,
not either engine directly. The HII layer owns:

- loopback-only serving on `127.0.0.1:11435`;
- model storage rooted at `~/.hii/models`, never Ollama's private blob layout;
- an atomic runtime manifest with source, revision, license/integrity state;
- an HII metrics discovery endpoint at `/v1/hii/metrics`;
- lifecycle ownership through `aii/daemon/hiid.mjs`.

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
