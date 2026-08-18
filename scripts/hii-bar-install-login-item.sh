#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-BSL-1.1
#
# Opt-in: install HII Bar as a login item via launchd.
#
# Nothing in the build path runs this. Installing a background agent onto a
# machine is the operator's decision, not a build step, so this is a separate
# command you run on purpose.
#
#   bash scripts/hii-bar-install-login-item.sh          # install + load
#   bash scripts/hii-bar-install-login-item.sh --remove # unload + remove

set -euo pipefail

label="ai.hii.bar"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_plist="$repo/launchd/$label.plist"
target_plist="$HOME/Library/LaunchAgents/$label.plist"
app="/Applications/HII Bar.app"

if [[ "${1:-}" == "--remove" ]]; then
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  rm -f "$target_plist"
  echo "removed $label"
  exit 0
fi

if [[ ! -d "$app" ]]; then
  echo "HII Bar is not installed at $app." >&2
  echo "Build it with: node scripts/hii-bar-build.mjs --release" >&2
  echo "Then copy 'macos/.build/HII Bar.app' into /Applications." >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.hii/bar"
# The shipped plist hardcodes /Users/ummi, matching launchd/ai.hii.daemon.plist.
# Rewrite it for whoever is actually installing.
sed "s#/Users/ummi#$HOME#g" "$source_plist" > "$target_plist"

launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$target_plist"
echo "installed $label -> $target_plist"
echo "log: $HOME/.hii/bar/hii-bar.launchd.log"
