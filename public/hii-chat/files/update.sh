#!/bin/sh
# SPDX-License-Identifier: LicenseRef-BSL-1.1
# Hash-checked updater for the browser-to-local HII Chat link.
set -eu

origin="${HII_LINK_ORIGIN:-https://humaninformationinterface.com/hii-chat}"
root="$HOME/.hii/link"
current="$root/current"
manifest_tmp=$(mktemp "${TMPDIR:-/tmp}/hii-chat-manifest.XXXXXX")
stage=$(mktemp -d "${TMPDIR:-/tmp}/hii-chat-update.XXXXXX")
trap 'rm -f "$manifest_tmp"; rm -rf "$stage"' EXIT HUP INT TERM

curl -fsSL "$origin/manifest.json" -o "$manifest_tmp"
version=$(node -e "const m=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); if(!/^1\.[0-9]+$/.test(m.version))process.exit(2); process.stdout.write(m.version)" "$manifest_tmp")
installed=$(cat "$root/version" 2>/dev/null || true)
if [ "${HII_FORCE_UPDATE:-0}" != "1" ] && [ "$installed" = "$version" ]; then
  exit 0
fi

files="hii-remote-host.mjs remote-source.mjs hii-remote-input.swift install-local.sh update.sh"
for file in $files; do
  case "$file" in
    hii-remote-host.mjs|remote-source.mjs|hii-remote-input.swift|install-local.sh|update.sh) ;;
    *) exit 3 ;;
  esac
  curl -fsSL "$origin/files/$file" -o "$stage/$file"
  expected=$(node -e "const m=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); const v=m.files[process.argv[2]]; if(!/^[a-f0-9]{64}$/.test(v||''))process.exit(2); process.stdout.write(v)" "$manifest_tmp" "$file")
  actual=$(shasum -a 256 "$stage/$file" | awk '{print $1}')
  [ "$actual" = "$expected" ] || { echo "HII Chat update refused: checksum mismatch for $file" >&2; exit 4; }
done

mkdir -p "$current" "$root"
for file in $files; do
  cp "$stage/$file" "$current/$file.next"
  mv "$current/$file.next" "$current/$file"
done
chmod 700 "$current/install-local.sh" "$current/update.sh"
cp "$current/update.sh" "$root/update.sh.next"
chmod 700 "$root/update.sh.next"
mv "$root/update.sh.next" "$root/update.sh"
printf '%s\n' "$version" > "$root/version"

token="${HII_PAIR_TOKEN:-}"
if [ -z "$token" ] && [ -f "$HOME/.hii/remote/host.json" ]; then
  token=$(node -e "const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); process.stdout.write(String(c.token||''))" "$HOME/.hii/remote/host.json")
fi
[ -n "$token" ] || { echo "HII Chat needs a pairing token from your account" >&2; exit 5; }
sh "$current/install-local.sh" "$token"
