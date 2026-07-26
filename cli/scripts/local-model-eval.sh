#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BIN="${HII_EVAL_BIN:-$ROOT/target/release/hii}"
MODEL_URL="${HII_MODEL_URL:-http://127.0.0.1:11434}"
ACTOR_MODELS="${HII_EVAL_ACTOR_MODELS:-qwen3.6:27b-mlx qwen3.6:35b-mlx}"
UTILITY_MODEL="${HII_EVAL_UTILITY_MODEL:-gemma4:e2b-mlx}"
EVAL_ROOT="$(mktemp -d /tmp/hii-local-model-eval.XXXXXX)"
RESULTS="$EVAL_ROOT/results.jsonl"
PASSED=0
FAILED=0

record() {
  local model="$1"
  local case_name="$2"
  local status="$3"
  local proof="$4"
  jq -nc \
    --arg model "$model" \
    --arg case "$case_name" \
    --arg status "$status" \
    --arg proof "$proof" \
    '{model:$model,case:$case,status:$status,proof:$proof}' >>"$RESULTS"
  if [[ "$status" == "passed" ]]; then
    PASSED=$((PASSED + 1))
    printf 'ok  %-22s %s\n' "$model" "$case_name"
  else
    FAILED=$((FAILED + 1))
    printf '!!  %-22s %s\n' "$model" "$case_name"
  fi
}

receipt_passes() {
  local runtime="$1"
  local latest
  latest="$(tr -d '\n' <"$runtime/runs/cli/latest" 2>/dev/null || true)"
  [[ -n "$latest" ]] || return 1
  jq -e \
    '.status == "completed" and (.verification | map(select(.ok == true)) | length) >= 1' \
    "$runtime/runs/cli/$latest/receipt.json" >/dev/null
}

run_actor() {
  local model="$1"
  local slug="${model//[^a-zA-Z0-9]/-}"
  local runtime="$EVAL_ROOT/runtime-$slug"
  local inspect_workspace="$EVAL_ROOT/$slug-inspect"
  local write_workspace="$EVAL_ROOT/$slug-write"
  local inspect_log="$EVAL_ROOT/$slug-inspect.log"
  local write_log="$EVAL_ROOT/$slug-write.log"
  mkdir -p "$runtime" "$inspect_workspace" "$write_workspace"

  if HII_ROOT="$ROOT" HII_RUNTIME_DIR="$runtime" "$BIN" \
    --cwd "$inspect_workspace" \
    --model "$model" \
    --max-steps 8 \
    run "Inspect this workspace with list, verify the exact workspace path with pwd, then finish without changing files." \
    >"$inspect_log" 2>&1 && receipt_passes "$runtime"; then
    record "$model" "inspect-verify-receipt" "passed" "$inspect_log"
  else
    record "$model" "inspect-verify-receipt" "failed" "$inspect_log"
    tail -30 "$inspect_log"
  fi

  if HII_ROOT="$ROOT" HII_RUNTIME_DIR="$runtime" "$BIN" \
    --cwd "$write_workspace" \
    --model "$model" \
    --max-steps 10 \
    run "Write hello.txt containing exactly hello from hii followed by one newline, verify its exact contents, then finish." \
    >"$write_log" 2>&1 \
    && [[ -f "$write_workspace/hello.txt" ]] \
    && [[ "$(wc -c <"$write_workspace/hello.txt" | tr -d ' ')" == "15" ]] \
    && grep -qx 'hello from hii' "$write_workspace/hello.txt" \
    && receipt_passes "$runtime"; then
    record "$model" "write-verify-receipt" "passed" "$write_log"
  else
    record "$model" "write-verify-receipt" "failed" "$write_log"
    tail -30 "$write_log"
  fi
}

probe_utility() {
  local model="$1"
  local response="$EVAL_ROOT/utility-response.json"
  local payload
  payload="$(
    jq -nc --arg model "$model" '{
      model:$model,
      stream:false,
      think:false,
      messages:[
        {role:"system",content:"You are a concise local text utility."},
        {role:"user",content:"Reply with exactly: utility ok"}
      ],
      options:{temperature:0.1,num_ctx:8192}
    }'
  )"
  if curl -fsS "$MODEL_URL/api/chat" \
    -H 'Content-Type: application/json' \
    --data-binary "$payload" >"$response" \
    && jq -er 'select(.message.content == "utility ok")' \
      "$response" >/dev/null; then
    record "$model" "utility-text-response" "passed" "$response"
  else
    record "$model" "utility-text-response" "failed" "$response"
    jq '{error,message}' "$response" 2>/dev/null || true
  fi
}

if [[ ! -x "$BIN" ]]; then
  printf 'Missing release binary: %s\nRun npm run cli:build first.\n' "$BIN" >&2
  exit 2
fi
command -v jq >/dev/null || {
  echo "jq is required" >&2
  exit 2
}
command -v curl >/dev/null || {
  echo "curl is required" >&2
  exit 2
}

for model in $ACTOR_MODELS; do
  run_actor "$model"
done
probe_utility "$UTILITY_MODEL"

printf '\npassed=%s failed=%s\n' "$PASSED" "$FAILED"
printf 'results=%s\n' "$RESULTS"
printf 'workspace=%s\n' "$EVAL_ROOT"
[[ "$FAILED" -eq 0 ]]
