#!/bin/sh
set -eu

rustc_path=$(rustup which --toolchain 1.97.1 rustc)
rust_bin=$(dirname "$rustc_path")
PATH="$rust_bin:$PATH" worker-build --release workers/public-site
