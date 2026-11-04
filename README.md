# HII CLI

This source snapshot contains the HII command-line application and its Rust workspace libraries. Install Rust and Cargo, clone this repository, and build the CLI from its root:

```sh
git clone https://github.com/umminuriddingreen/hii.git
cd hii
```

Then build:

```sh
cargo build -p hii-cli
```

The debug executable is `target/debug/hii`. To see the commands and options available in this build:

```sh
target/debug/hii --help
```

Run commands from a workspace directory to use it as the default project context. HII keeps user runtime data under `~/.hii` by default; `HII_RUNTIME_DIR` selects a different runtime-data directory. `HII_HOME` can be used by commands that explicitly support it; see each command's help for its options.

Model routing can be configured with `HII_MODEL_URL` and `HII_MODEL_PROVIDER`. The legacy URL variables `HII_RAPID_MLX_URL` and `HII_OLLAMA_URL` are also recognized. The CLI expects a compatible inference service to be available at the configured endpoint. API credentials, when needed, can be supplied through `HII_MODEL_API_KEY` or `HII_MODEL_API_KEY_FILE`; keep credentials out of source control and shell history.

HII can also keep named runtime connections, independently of the inference engine. Splash, llama.cpp, LM Studio, MLX servers, vLLM, and other OpenAI-compatible servers use the `openai` protocol; Ollama can use its native `ollama` protocol. Start the server separately, then register its actual endpoint and model ID:

```sh
hii backend add splash --url http://127.0.0.1:1111/v1 --default-model '<model-id>'
hii backend add ollama --url http://127.0.0.1:11434 --protocol ollama --default-model '<ollama-tag>'
hii backend add llamacpp --url http://127.0.0.1:8080 --default-model '<served-model-id>'
hii backend list
hii backend test splash
hii backend use splash
hii ask 'Hello'
```

Use the port your server actually listens on; these are examples. `backend test` checks its model catalog, and a successful `ask` verifies a completion. Selection applies to new chat and agent sessions and keeps each backend's model choice separate. Registering, selecting, or removing a connection does not start or stop a server, download weights, or delete models. Explicit environment overrides take precedence; an unavailable selected backend reports an error instead of silently switching engines.

`hii backend add NAME --url URL --config backend.json` also accepts model aliases, request defaults, and header references from a backend configuration. Authentication headers must use `env:VARIABLE_NAME` or `file:/absolute/path` references; inspection redacts header values. The existing `hii model` commands manage HII's native model installation and lifecycle separately.

This repository provides the CLI source. Building it does not install a model, start an inference server, configure credentials, or verify a runtime endpoint. Platform-specific integrations may require additional tools or permissions.

## License

First-party HII source is licensed under the Apache License, Version 2.0; see `LICENSE` and `NOTICE`. Third-party components retain their own license terms and copyright notices. HII and Human Information Interface trademarks are not granted by the software license; see `TRADEMARK.md`.
