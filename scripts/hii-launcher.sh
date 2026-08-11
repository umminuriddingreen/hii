#!/usr/bin/env bash

set -euo pipefail

hii_repo="${HII_ROOT:-${HOME}/hii}"
hii_rust_bin="${HII_CLI_BIN:-${hii_repo}/target/release/hii}"
hii_cargo_bin="${HII_CARGO_BIN:-cargo}"
hii_manifest="${hii_repo}/Cargo.toml"

needs_build=0
source_stamp="${hii_rust_bin}.source"

source_fingerprint() {
  {
    for source_marker in Cargo.toml Cargo.lock cli/Cargo.toml; do
      if [[ -f "${hii_repo}/${source_marker}" ]]; then
        printf '%s\t' "${source_marker}"
        cksum "${hii_repo}/${source_marker}"
      fi
    done
    if [[ -d "${hii_repo}/cli/src" ]]; then
      find "${hii_repo}/cli/src" -type f \( -name '*.rs' -o -name '*.toml' \) -print \
        | LC_ALL=C sort \
        | while IFS= read -r source_file; do
            printf '%s\t' "${source_file#"${hii_repo}/"}"
            cksum "${source_file}"
          done
    fi
  } | cksum | awk '{print $1 ":" $2}'
}

current_source="$(source_fingerprint)"

if [[ ! -x "${hii_rust_bin}" ]]; then
  needs_build=1
elif [[ ! -f "${source_stamp}" ]] || [[ "$(<"${source_stamp}")" != "${current_source}" ]]; then
  needs_build=1
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
  printf '%s\n' "${current_source}" > "${source_stamp}"
fi

if [[ ! -x "${hii_rust_bin}" ]]; then
  printf 'hii: release CLI is unavailable at %s\n' "${hii_rust_bin}" >&2
  exit 1
fi

exec "${hii_rust_bin}" "$@"
