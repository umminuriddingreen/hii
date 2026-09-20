#!/bin/sh
# SPDX-License-Identifier: LicenseRef-BSL-1.1
#
# Install the HII paired-host agent on this Mac.
#   sh remote/host/install.sh <pairing-token>
#
# Writes the host config and installs a launchd agent that keeps the outbound
# relay connection alive across logins. The agent answers chat over the paired
# link; it does not capture the screen or replay remote input.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
bin_dir="$HOME/.hii/bin"
conf_dir="$HOME/.hii/remote"
log_dir="$HOME/.hii/logs"
plist="$HOME/Library/LaunchAgents/ai.hii.remote-host.plist"
update_plist="$HOME/Library/LaunchAgents/ai.hii.remote-host-update.plist"
update_script="$HOME/.hii/link/update.sh"
token="${1:-}"
if [ -z "$token" ] && [ -f "$conf_dir/host.json" ]; then
  token=$(node -e "const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); process.stdout.write(String(c.token||''))" "$conf_dir/host.json")
fi
if [ -z "$token" ]; then
  echo "usage: sh install.sh <pairing-token>" >&2
  echo "Create a token at https://humaninformationinterface.com/remote" >&2
  exit 2
fi
node_bin=$(command -v node || true)
hii_bin=${HII_BIN:-$(command -v hii || true)}
if [ -z "$hii_bin" ] && [ -x "$HOME/.local/bin/hii" ]; then
  hii_bin="$HOME/.local/bin/hii"
fi

[ -n "$node_bin" ] || { echo "Node.js is required. Install it from https://nodejs.org, then retry." >&2; exit 3; }
[ -n "$hii_bin" ] || { echo "HII is required. Install it with: curl -fsSL https://humaninformationinterface.com/install | sh" >&2; exit 3; }

mkdir -p "$bin_dir" "$conf_dir" "$log_dir" "$(dirname "$plist")"
chmod 700 "$conf_dir"

bootstrap_agent() {
  domain="$1"
  source_plist="$2"
  attempt=1
  while [ "$attempt" -le 5 ]; do
    if launchctl bootstrap "$domain" "$source_plist" 2>/dev/null; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  launchctl bootstrap "$domain" "$source_plist"
}

cat > "$conf_dir/host.json" <<JSON
{
  "relay": "${HII_REMOTE_RELAY:-wss://humaninformationinterface.com/api/remote/host}",
  "token": "$token",
  "hii": "$hii_bin",
  "chatCwd": "$HOME"
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
    <string>/usr/bin/env</string>
    <string>-i</string>
    <string>HOME=$HOME</string>
    <string>PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <string>$node_bin</string>
    <string>$here/hii-remote-host.mjs</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$log_dir/remote-host.log</string>
  <key>StandardErrorPath</key><string>$log_dir/remote-host.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/ai.hii.remote-host" 2>/dev/null || true
bootstrap_agent "gui/$(id -u)" "$plist"

if [ -f "$update_script" ]; then
  cat > "$update_plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.hii.remote-host-update</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>-i</string>
    <string>HOME=$HOME</string>
    <string>PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <string>HII_NODE_BIN=$node_bin</string>
    <string>/bin/sh</string>
    <string>$update_script</string>
  </array>
  <key>StartInterval</key><integer>900</integer>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$log_dir/remote-host-update.log</string>
  <key>StandardErrorPath</key><string>$log_dir/remote-host-update.log</string>
</dict>
</plist>
PLIST
  launchctl bootout "gui/$(id -u)/ai.hii.remote-host-update" 2>/dev/null || true
  bootstrap_agent "gui/$(id -u)" "$update_plist"
fi

cat <<'NOTE'

Installed. This agent needs no screen-recording or accessibility permission:
it never captures the screen and never replays remote input.

Logs: ~/.hii/logs/remote-host.log
Stop: launchctl bootout gui/$(id -u)/ai.hii.remote-host
Updates: checksum-verified every 15 minutes from the canonical HII HTTPS origin
NOTE
