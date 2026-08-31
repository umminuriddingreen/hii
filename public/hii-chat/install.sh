#!/bin/sh
# Install or reconnect HII Chat from the canonical HII web origin.
set -eu

token="${1:-}"
if [ -z "$token" ]; then
  if [ -r /dev/tty ]; then
    printf 'HII pairing token: ' > /dev/tty
    IFS= read -r token < /dev/tty
  fi
fi
[ -n "$token" ] || { echo "A pairing token from your signed-in HII account is required." >&2; exit 2; }
if [ "$(uname -s)" != "Darwin" ]; then
  echo "The live HII Chat installer currently supports macOS. Windows and Linux links will use this same account-scoped protocol." >&2
  exit 3
fi

root="$HOME/.hii/link"
mkdir -p "$root"
chmod 700 "$root"
curl -fsSL "https://humaninformationinterface.com/hii-chat/files/update.sh" -o "$root/update.sh.next"
chmod 700 "$root/update.sh.next"
mv "$root/update.sh.next" "$root/update.sh"
HII_PAIR_TOKEN="$token" HII_FORCE_UPDATE=1 /bin/sh "$root/update.sh"
