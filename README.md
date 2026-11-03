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

This repository provides the CLI source. Building it does not install a model, start an inference server, configure credentials, or verify a runtime endpoint. Platform-specific integrations may require additional tools or permissions.

## License

First-party HII source is licensed under the Apache License, Version 2.0; see `LICENSE` and `NOTICE`. Third-party components retain their own license terms and copyright notices. HII and Human Information Interface trademarks are not granted by the software license; see `TRADEMARK.md`.
