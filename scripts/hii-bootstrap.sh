#!/usr/bin/env bash

set -euo pipefail

DRY_RUN=0
WITH_OLLAMA=0
ENABLE_DAEMON=0
APP_PATH="/Applications/HII.app"
RUNTIME_DIR="${HOME}/.hii"
PLIST_PATH="${HOME}/Library/LaunchAgents/com.ummi.hii.hiid.plist"
EMBEDDED_ROOT="${APP_PATH}/Contents/Resources/hii-app"
NODE_PATH="${EMBEDDED_ROOT}/bin/node"
HIID_PATH="${EMBEDDED_ROOT}/server/runtime/daemon/hiid.mjs"
LABEL="com.ummi.hii.hiid"

usage() {
  cat <<'EOF'
HII partner bootstrap (Apple Silicon, macOS 13+)

Usage: bash hii-bootstrap.sh [options]

Options:
  --dry-run        Print every action without changing anything
  --with-ollama    Print optional Ollama install and model commands (never runs them)
  --enable-daemon  Write the plist and load hiid with launchctl
  --help           Show this help

This script never installs agents, uses sudo, or makes network calls.
EOF
}

for argument in "$@"; do
  case "${argument}" in
    --dry-run) DRY_RUN=1 ;;
    --with-ollama) WITH_OLLAMA=1 ;;
    --enable-daemon) ENABLE_DAEMON=1 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Error: unknown option: ${argument}" >&2; usage >&2; exit 2 ;;
  esac
done

say() {
  printf '%s\n' "$*"
}

step() {
  printf '\n==> %s\n' "$*"
}

if (( DRY_RUN )); then
  say "DRY RUN: no files will be created or changed, and no service will be loaded."
fi

step "1/5 — Check this Mac"
if (( DRY_RUN )); then
  say "Would verify that this is an Apple Silicon Mac running macOS 13 or newer."
else
  architecture="$(uname -m)"
  if [[ "${architecture}" != "arm64" ]]; then
    say "Error: HII requires an Apple Silicon Mac (M1 or newer). This Mac reports ${architecture}." >&2
    exit 1
  fi

  if [[ "$(uname -s)" != "Darwin" ]]; then
    say "Error: HII requires macOS 13 or newer." >&2
    exit 1
  fi

  macos_version="$(sw_vers -productVersion)"
  macos_major="${macos_version%%.*}"
  if [[ ! "${macos_major}" =~ ^[0-9]+$ ]] || (( macos_major < 13 )); then
    say "Error: HII requires macOS 13 or newer. This Mac is running macOS ${macos_version}." >&2
    exit 1
  fi
  say "Compatible: Apple Silicon, macOS ${macos_version}."
fi

step "2/5 — Prepare HII's local folders"
runtime_dirs=(
  "${RUNTIME_DIR}/daemon"
  "${RUNTIME_DIR}/runs/cli"
  "${RUNTIME_DIR}/activations"
  "${RUNTIME_DIR}/traces"
  "${RUNTIME_DIR}/skills"
)
for directory in "${runtime_dirs[@]}"; do
  if (( DRY_RUN )); then
    say "Would ensure folder exists: ${directory}"
  elif [[ -d "${directory}" ]]; then
    say "Already exists; leaving unchanged: ${directory}"
  else
    say "Creating: ${directory}"
    mkdir -p "${directory}"
  fi
done

agent_path() {
  local name="$1"
  local found=""
  found="$(command -v "${name}" 2>/dev/null || true)"
  if [[ -z "${found}" && -x "/opt/homebrew/bin/${name}" ]]; then
    found="/opt/homebrew/bin/${name}"
  fi
  printf '%s' "${found}"
}

step "3/5 — Detect installed agents (no agents will be launched)"
printf '%-10s %-12s %-24s %s\n' "Agent" "Installed" "Auth status" "Location"
printf '%-10s %-12s %-24s %s\n' "----------" "------------" "------------------------" "--------"
if (( DRY_RUN )); then
  for agent in codex claude ollama; do
    printf '%-10s %-12s %-24s %s\n' "${agent}" "not checked" "not checked (dry run)" "Would inspect PATH and /opt/homebrew/bin"
  done
else
  for agent in codex claude ollama; do
    location="$(agent_path "${agent}")"
    installed="no"
    auth_status="not available"
    if [[ -n "${location}" ]]; then
      installed="yes"
      case "${agent}" in
        codex)
          [[ -s "${HOME}/.codex/auth.json" ]] && auth_status="credentials found" || auth_status="login may be needed"
          ;;
        claude)
          if [[ -s "${HOME}/.claude.json" || -s "${HOME}/.claude/.credentials.json" ]]; then
            auth_status="credentials found"
          else
            auth_status="login may be needed"
          fi
          ;;
        ollama) auth_status="no account required" ;;
      esac
    fi
    printf '%-10s %-12s %-24s %s\n' "${agent}" "${installed}" "${auth_status}" "${location:--}"
  done
fi

step "4/5 — Optional Ollama setup"
if (( WITH_OLLAMA )); then
  say "Optional commands for the partner to run (this script will not run them):"
  say "  brew install --cask ollama"
  say "  ollama pull qwen3.6:27b"
else
  say "Skipped. Re-run with --with-ollama to print optional install and model commands."
fi

step "5/5 — Configure the local hiid daemon"
if (( DRY_RUN )); then
  say "Would check for ${APP_PATH}."
  say "Would write ${PLIST_PATH} only if the app and embedded hiid runtime are present."
  if (( ENABLE_DAEMON )); then
    say "Would run: launchctl load ${PLIST_PATH}"
  else
    say "Would print (but not run): launchctl load ${PLIST_PATH}"
  fi
elif [[ ! -d "${APP_PATH}" ]]; then
  say "HII.app was not found at ${APP_PATH}."
  say "Drag HII.app into Applications, then run this bootstrap script again."
elif [[ ! -x "${NODE_PATH}" || ! -f "${HIID_PATH}" ]]; then
  say "HII.app is present, but its embedded hiid runtime is incomplete."
  say "Expected: ${NODE_PATH}"
  say "Expected: ${HIID_PATH}"
  say "Replace HII.app with the complete signed partner build, then run this script again."
else
  say "Ensuring LaunchAgents folder exists: ${HOME}/Library/LaunchAgents"
  mkdir -p "${HOME}/Library/LaunchAgents"
  say "Writing daemon configuration: ${PLIST_PATH}"
  plist_tmp="$(mktemp "${PLIST_PATH}.tmp.XXXXXX")"
  trap 'rm -f "${plist_tmp:-}"' EXIT
  cat >"${plist_tmp}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_PATH}</string>
    <string>${HIID_PATH}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${EMBEDDED_ROOT}/server</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${RUNTIME_DIR}/daemon/launchd.log</string>
  <key>StandardErrorPath</key>
  <string>${RUNTIME_DIR}/daemon/launchd-error.log</string>
</dict>
</plist>
EOF
  chmod 600 "${plist_tmp}"
  mv "${plist_tmp}" "${PLIST_PATH}"
  trap - EXIT
  say "Installed: ${PLIST_PATH}"
  if (( ENABLE_DAEMON )); then
    say "Loading hiid now: launchctl load ${PLIST_PATH}"
    launchctl load "${PLIST_PATH}"
    say "hiid is configured to start for this user."
  else
    say "Daemon loading is off by default. To enable it, run:"
    say "  launchctl load ${PLIST_PATH}"
    say "Or re-run: bash hii-bootstrap.sh --enable-daemon"
  fi
fi

say ""
say "HII bootstrap finished. Existing HII state was left in place."
