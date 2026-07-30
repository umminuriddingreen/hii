#!/usr/bin/env bash

set -euo pipefail

hii_repo="${HII_ROOT:-${HOME}/hii}"
hii_rust_bin="${HII_CLI_BIN:-${hii_repo}/target/release/hii}"
hii_cargo_bin="${HII_CARGO_BIN:-cargo}"
hii_manifest="${hii_repo}/Cargo.toml"

needs_build=0
cli_tree_dirty=0

if [[ ! -x "${hii_rust_bin}" ]]; then
  needs_build=1
else
  if command -v git >/dev/null 2>&1; then
    dirty_cli="$(
      git -C "${hii_repo}" status --porcelain --untracked-files=normal -- \
        Cargo.toml Cargo.lock cli 2>/dev/null || true
    )"
    if [[ -n "${dirty_cli}" ]]; then
      cli_tree_dirty=1
    fi
  fi

  source_markers=(
    "${hii_repo}/Cargo.toml"
    "${hii_repo}/Cargo.lock"
    "${hii_repo}/cli/Cargo.toml"
  )
  if (( ! cli_tree_dirty )); then
    for source_marker in "${source_markers[@]}"; do
      if [[ -f "${source_marker}" && "${source_marker}" -nt "${hii_rust_bin}" ]]; then
        needs_build=1
        break
      fi
    done
  fi

  if (( ! cli_tree_dirty && ! needs_build )) && [[ -d "${hii_repo}/cli/src" ]]; then
    newer_source="$(
      find "${hii_repo}/cli/src" \
        \( -type d -o \( -type f \( -name '*.rs' -o -name '*.toml' \) \) \) \
        -newer "${hii_rust_bin}" -print -quit
    )"
    if [[ -n "${newer_source}" ]]; then
      needs_build=1
    fi
  fi
fi

if (( needs_build )); then
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
