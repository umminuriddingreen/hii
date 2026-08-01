#!/usr/bin/env bash
# Deterministic harness regression suite. Unlike local-model-eval.sh (which is the
# real-model nightly gate) this drives the agent loop against tests/fixtures/fake_model.mjs,
# so it runs in seconds and asserts exact outcomes.
#
#   cli/scripts/regression.sh [case-name ...]
#
# Cases are added as the phases that make them pass land; each one names the
# behavior it protects.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BIN="${HII_REGRESSION_BIN:-$ROOT/target/debug/hii}"
FIXTURE="$ROOT/cli/tests/fixtures/fake_model.mjs"
EVAL_ROOT="$(mktemp -d /tmp/hii-regression.XXXXXX)"
PASSED=0
FAILED=0
ONLY=("$@")

cleanup() {
  [[ -n "${FAKE_PID:-}" ]] && kill "$FAKE_PID" 2>/dev/null
  return 0
}
trap cleanup EXIT

record() {
  local case_name="$1" status="$2" detail="${3:-}"
  if [[ "$status" == "passed" ]]; then
    PASSED=$((PASSED + 1))
    printf 'ok  %s\n' "$case_name"
  else
    FAILED=$((FAILED + 1))
    printf '!!  %s\n    %s\n' "$case_name" "$detail"
  fi
}

selected() {
  [[ -z "${ONLY[*]:-}" ]] && return 0
  local want
  for want in "${ONLY[@]}"; do [[ "$want" == "$1" ]] && return 0; done
  return 1
}

# A git workspace with the seeded `add()` bug and a stdlib-unittest check.
make_repo() {
  local dir="$1"
  rm -rf "$dir"
  mkdir -p "$dir"
  printf 'def add(a, b):\n    return a - b\n\n\ndef mul(a, b):\n    return a * b\n' >"$dir/calc.py"
  cat >"$dir/test_calc.py" <<'PY'
import unittest
from calc import add, mul


class T(unittest.TestCase):
    def test_add(self):
        self.assertEqual(add(2, 3), 5)

    def test_mul(self):
        self.assertEqual(mul(2, 3), 6)


if __name__ == "__main__":
    unittest.main()
PY
  git -C "$dir" init -q .
  git -C "$dir" add -A
  git -C "$dir" -c user.email=regression@hii -c user.name=regression commit -qm init
}

start_model() {
  local scenario="$1"
  local portfile="$EVAL_ROOT/$scenario.port"
  node "$FIXTURE" --scenario "$scenario" >"$portfile" 2>&1 &
  FAKE_PID=$!
  local tries=0
  while [[ $tries -lt 50 ]]; do
    PORT="$(sed -n 's/^PORT=//p' "$portfile")"
    [[ -n "$PORT" ]] && return 0
    sleep 0.1
    tries=$((tries + 1))
  done
  echo "fake model failed to start for scenario $scenario" >&2
  return 1
}

stop_model() {
  [[ -n "${FAKE_PID:-}" ]] && kill "$FAKE_PID" 2>/dev/null
  FAKE_PID=""
  return 0
}

# hii_run <runtime> <workspace> <logfile> [extra args...]; sets RUN_EXIT.
hii_run() {
  local runtime="$1" workspace="$2" log="$3"
  shift 3
  mkdir -p "$runtime"
  HII_ROOT="$ROOT" HII_RUNTIME_DIR="$runtime" HII_MODEL_URL="http://127.0.0.1:$PORT" \
    "$BIN" --cwd "$workspace" --model fake-model "$@" >"$log" 2>&1
  RUN_EXIT=$?
}

receipt_count() { find "$1/runs/cli" -name receipt.json 2>/dev/null | wc -l | tr -d ' '; }
latest_receipt() {
  local latest
  latest="$(cat "$1/runs/cli/latest" 2>/dev/null | tr -d '\n')"
  [[ -n "$latest" ]] && echo "$1/runs/cli/$latest/receipt.json"
}

# --- 1. happy path -----------------------------------------------------------
# The agent fixes the bug, verifies it, and records exactly one passing check.
case_happy_path() {
  local rt="$EVAL_ROOT/rt-happy" ws="$EVAL_ROOT/ws-happy" log="$EVAL_ROOT/happy.log"
  make_repo "$ws"
  start_model happy_calc || return
  # The declared check is the same command the model runs itself, so this also
  # guards against the acceptance replay recording (and re-running) it twice.
  hii_run "$rt" "$ws" "$log" --max-steps 8 run "fix the failing add test" \
    --verify "python3 -m unittest -q"
  stop_model

  local receipt
  receipt="$(latest_receipt "$rt")"
  if [[ "$RUN_EXIT" -ne 0 ]]; then
    record happy_path failed "exit $RUN_EXIT; $(tail -3 "$log")"
  elif ! grep -q 'return a + b' "$ws/calc.py"; then
    record happy_path failed "calc.py was not fixed"
  elif [[ -z "$receipt" ]] || ! jq -e '.status == "completed"' "$receipt" >/dev/null; then
    record happy_path failed "receipt missing or not completed"
  elif ! jq -e '[.verification[] | select(.ok)] | length == 1' "$receipt" >/dev/null; then
    record happy_path failed "expected exactly 1 passing check, got $(jq -c '[.verification[].command]' "$receipt")"
  else
    record happy_path passed
  fi
}

# --- 3. loop abort -----------------------------------------------------------
# A model that repeats itself must still leave a receipt and a fresh pointer.
case_loop_abort() {
  local rt="$EVAL_ROOT/rt-loop" ws="$EVAL_ROOT/ws-loop" log="$EVAL_ROOT/loop.log"
  make_repo "$ws"
  start_model repeats_block || return
  hii_run "$rt" "$ws" "$log" --max-steps 8 run "fix the failing add test"
  stop_model

  local receipt
  receipt="$(latest_receipt "$rt")"
  if [[ -z "$receipt" || ! -f "$receipt" ]]; then
    record loop_abort failed "no receipt written for an aborted run"
  elif ! jq -e '.outcome == "loop-abort"' "$receipt" >/dev/null 2>&1; then
    record loop_abort failed "outcome=$(jq -r '.outcome // "<missing>"' "$receipt") want loop-abort"
  elif [[ "$RUN_EXIT" -ne 6 ]]; then
    record loop_abort failed "exit $RUN_EXIT want 6"
  else
    record loop_abort passed
  fi
}

# --- 4. provider error -------------------------------------------------------
# The headline defect: a transport failure used to write no receipt at all and
# leave `latest` pointing at an unrelated run in another workspace.
case_provider_error() {
  local rt="$EVAL_ROOT/rt-provider" ws="$EVAL_ROOT/ws-provider" log="$EVAL_ROOT/provider.log"
  make_repo "$ws"
  start_model transport_500 || return
  hii_run "$rt" "$ws" "$log" --max-steps 5 run "fix the failing add test"
  stop_model

  local receipt
  receipt="$(latest_receipt "$rt")"
  if [[ "$(receipt_count "$rt")" -eq 0 ]]; then
    record provider_error failed "no receipt written for a provider failure"
  elif [[ -z "$receipt" ]]; then
    record provider_error failed "latest pointer not updated"
  elif ! jq -e '.outcome == "provider-error"' "$receipt" >/dev/null 2>&1; then
    record provider_error failed "outcome=$(jq -r '.outcome // "<missing>"' "$receipt") want provider-error"
  else
    record provider_error passed
  fi
}

# --- 5. proof in a clean workspace -------------------------------------------
# `hii proof` in a workspace with no runs must not silently show another
# workspace's receipt; explicit ids must still resolve from anywhere.
case_proof_scope() {
  local rt="$EVAL_ROOT/rt-proof" wsa="$EVAL_ROOT/ws-proof-a" wsb="$EVAL_ROOT/ws-proof-b"
  local log="$EVAL_ROOT/proof-a.log" out="$EVAL_ROOT/proof-b.out"
  make_repo "$wsa"
  make_repo "$wsb"
  start_model happy_calc || return
  hii_run "$rt" "$wsa" "$log" --max-steps 8 run "fix the failing add test"
  stop_model

  local id
  id="$(tr -d '\n' <"$rt/runs/cli/latest" 2>/dev/null)"
  HII_ROOT="$ROOT" HII_RUNTIME_DIR="$rt" "$BIN" --cwd "$wsb" proof >"$out" 2>&1
  local proof_exit=$?

  if [[ $proof_exit -eq 0 ]] && grep -q "$wsa" "$out"; then
    record proof_scope failed "proof in workspace B printed workspace A's receipt"
  elif ! grep -qi "$wsb\|no receipts" "$out"; then
    record proof_scope failed "error did not name the empty workspace: $(head -2 "$out")"
  elif ! HII_ROOT="$ROOT" HII_RUNTIME_DIR="$rt" "$BIN" --cwd "$wsb" proof "$id" >/dev/null 2>&1; then
    record proof_scope failed "explicit id no longer resolves across workspaces"
  else
    record proof_scope passed
  fi
}

[[ -x "$BIN" ]] || {
  printf 'Missing binary: %s\nRun cargo build -p hii-cli first.\n' "$BIN" >&2
  exit 2
}
command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }
command -v node >/dev/null || { echo "node is required" >&2; exit 2; }

for name in happy_path loop_abort provider_error proof_scope; do
  selected "$name" && "case_$name"
done

printf '\npassed=%s failed=%s\n' "$PASSED" "$FAILED"
printf 'workspace=%s\n' "$EVAL_ROOT"
[[ "$FAILED" -eq 0 ]]
