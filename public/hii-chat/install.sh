#!/bin/sh
# Install or reconnect HII Chat from the canonical HII web origin.
set -eu

say() { printf 'HII setup: %s\n' "$1" >&2; }
die() { printf 'HII setup: %s\n' "$1" >&2; exit 1; }

if [ "$(uname -s)" != "Darwin" ]; then
  die "this paired-computer installer currently supports macOS."
fi
command -v curl >/dev/null 2>&1 || die "curl is required."
command -v node >/dev/null 2>&1 || die "Node.js is required. Install it from https://nodejs.org, then run this command again."

token="${1:-}"
if [ -z "$token" ]; then
  if [ -r /dev/tty ]; then
    printf 'HII pairing token: ' > /dev/tty
    IFS= read -r token < /dev/tty
  fi
fi
[ -n "$token" ] || { echo "A pairing token from your signed-in HII account is required." >&2; exit 2; }

if command -v hii >/dev/null 2>&1; then
  hii_bin=$(command -v hii)
elif [ -x "$HOME/.local/bin/hii" ]; then
  hii_bin="$HOME/.local/bin/hii"
else
  die "HII is not installed. Run 'curl -fsSL https://humaninformationinterface.com/install | sh', then run this command again."
fi

root="$HOME/.hii/link"
mkdir -p "$root"
chmod 700 "$root"
say "downloading the verified computer link"
curl -fsSL "https://humaninformationinterface.com/hii-chat/files/update.sh" -o "$root/update.sh.next"
chmod 700 "$root/update.sh.next"
mv "$root/update.sh.next" "$root/update.sh"
HII_BIN="$hii_bin" HII_NODE_BIN="$(command -v node)" HII_PAIR_TOKEN="$token" HII_FORCE_UPDATE=1 /bin/sh "$root/update.sh"
say "complete — this Mac is paired and will reconnect automatically"
