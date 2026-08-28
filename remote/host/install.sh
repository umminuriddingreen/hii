#!/bin/sh
# SPDX-License-Identifier: LicenseRef-BSL-1.1
#
# Install the HII remote desktop host agent on this Mac.
#   sh remote/host/install.sh <pairing-token>
#
# Builds the input injector, writes the host config, and installs a launchd
# agent that keeps the outbound relay connection alive across logins.
set -eu

token="${1:-}"
if [ -z "$token" ]; then
  echo "usage: sh install.sh <pairing-token>" >&2
  echo "Create a token at https://humaninformationinterface.com/remote" >&2
  exit 2
fi

here=$(cd "$(dirname "$0")" && pwd)
bin_dir="$HOME/.hii/bin"
conf_dir="$HOME/.hii/remote"
log_dir="$HOME/.hii/logs"
plist="$HOME/Library/LaunchAgents/ai.hii.remote-host.plist"
node_bin=$(command -v node)

command -v ffmpeg >/dev/null || { echo "ffmpeg is required: brew install ffmpeg" >&2; exit 3; }
[ -n "$node_bin" ] || { echo "node is required" >&2; exit 3; }

mkdir -p "$bin_dir" "$conf_dir" "$log_dir" "$(dirname "$plist")"
chmod 700 "$conf_dir"

echo "building input injector..."
swiftc -O -o "$bin_dir/hii-remote-input" "$here/hii-remote-input.swift"

cat > "$conf_dir/host.json" <<JSON
{
  "relay": "${HII_REMOTE_RELAY:-wss://humaninformationinterface.com/api/remote/host}",
  "token": "$token",
  "fps": 24,
  "quality": 6,
  "maxWidth": 1600,
  "display": 0
}
JSON
chmod 600 "$conf_dir/host.json"

cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.hii.remote-host</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node_bin</string>
    <string>$here/hii-remote-host.mjs</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$log_dir/remote-host.log</string>
  <key>StandardErrorPath</key><string>$log_dir/remote-host.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/ai.hii.remote-host" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"

cat <<'NOTE'

Installed. Two macOS permissions are required before the stream works:

  System Settings > Privacy & Security > Screen & System Audio Recording
    -> allow the terminal or launchd process running ffmpeg
  System Settings > Privacy & Security > Accessibility
    -> allow ~/.hii/bin/hii-remote-input

Logs: ~/.hii/logs/remote-host.log
Stop: launchctl bootout gui/$(id -u)/ai.hii.remote-host
NOTE
