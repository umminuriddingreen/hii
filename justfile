# Fast feedback without restarting or switching the inference server.
default:
    @just --list

dev:
    bacon check

check:
    cargo check -p hii-cli

build:
    cargo build -p hii-cli

test *args:
    cargo test -p hii-cli {{args}}

lint:
    cargo clippy -p hii-cli --all-targets

fmt:
    cargo fmt --all -- --check

verify: fmt test lint
    node --test scripts/hii-agent-setup.test.mjs

setup:
    cargo run -p hii-cli -- setup --json

# Rebuild only; existing chats and model servers keep running.
watch-build:
    watchexec --watch cli/src --watch crates --watch fabric/protocol --watch Cargo.toml --watch Cargo.lock --exts rs,toml,lock -- cargo build -p hii-cli

# Run the freshly built diagnostic command; never restart interactive chats.
watch-status:
    watchexec --watch cli/src --watch crates --watch fabric/protocol --watch Cargo.toml --exts rs,toml -- cargo run -p hii-cli -- status --json

# Use HII's release installer, preserving bundled resources and provenance.
install:
    node scripts/hii-release-installer.mjs --source-root .
