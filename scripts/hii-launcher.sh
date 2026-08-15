#!/usr/bin/env bash

set -euo pipefail

hii_repo="${HII_ROOT:-${HOME}/hii}"
hii_rust_bin="${HII_CLI_BIN:-${hii_repo}/target/release/hii}"
hii_cargo_bin="${HII_CARGO_BIN:-cargo}"
hii_manifest="${hii_repo}/Cargo.toml"

if [[ ! -x "${hii_rust_bin}" ]]; then
  if [[ ! -f "${hii_manifest}" ]]; then
    printf 'hii: cannot build the CLI because %s is missing\n' "${hii_manifest}" >&2
    exit 1
  fi
  "${hii_cargo_bin}" build \
    --manifest-path "${hii_manifest}" \
    --package hii-cli \
    --release \
    --quiet
fi

if [[ ! -x "${hii_rust_bin}" ]]; then
  printf 'hii: release CLI is unavailable at %s\n' "${hii_rust_bin}" >&2
  exit 1
fi

exec "${hii_rust_bin}" "$@"
