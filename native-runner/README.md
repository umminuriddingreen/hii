# HII native model runner

`hii-native-runner` is HII's native Apple-Silicon inference service. It embeds
the upstream MIT-licensed `mistralrs-server-core` crate and adds a deliberately
small HII layer:

- loopback-only serving on `127.0.0.1:11435`;
- model storage rooted at `~/.hii/models`, never Ollama's private blob layout;
- an atomic runtime manifest with source, revision, license/integrity state;
- an HII metrics discovery endpoint at `/v1/hii/metrics`;
- lifecycle ownership through `aii/daemon/hiid.mjs`.

The upstream OpenAI-compatible surface provides `/health`, `/v1/models`, and
streaming `/v1/chat/completions`. HII does not fork those handlers. Keeping the
integration at the public crate boundary makes upstream updates reviewable and
keeps the engine replaceable.

## Consumer commands

```sh
hii runner model doctor
npm run runner:build
hii runner model start --model Qwen/Qwen3-4B
hii runner model status
hii runner model bench
hii runner model stop
```

Starting a model is the explicit acquisition boundary. HII does not download
weights during install or `doctor`. Hosted Codex and Claude use also remains an
explicit action; local `auto` routing does not silently transmit prompts.

## Backend boundary

The production backend is mistral.rs with Metal. A Swift/MLX worker is reserved
behind a Unix-socket adapter contract so MLX can be evaluated without making
Python, Ollama, LM Studio, or another daemon a runtime dependency.
