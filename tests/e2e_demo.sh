#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# End-to-end test of the two-process remote-DSpark demo.
#
# Boots the edge daemon and the patched llama-server, then:
#   1. /v1/completions with a deterministic prompt
#   2. /v1/chat/completions (second request on a reused slot — regression
#      check for the prompt-batch output-buffer overflow)
#   3. asserts /debug/spec shows the drafter connected and drafting
#
# Env (same knobs as run_demo.sh):
#   TARGET_MODEL, DRAFT_MODEL, NGL, FLASH_ATTN, CTX, NMAX, HTTP_PORT, GRPC_PORT

BUILD_DIR="${BUILD_DIR:-build}"
DAEMON="$BUILD_DIR/tools/llama-dspark-grpcd/llama-dspark-grpcd"
SERVER="$BUILD_DIR/bin/llama-server"

MODELS_DIR="${MODELS_DIR:-models}"
TARGET_MODEL="${TARGET_MODEL:-$MODELS_DIR/gemma-4-12B-it-Q4_K_M.gguf}"
DRAFT_MODEL="${DRAFT_MODEL:-$MODELS_DIR/dspark_gemma4_12b_q4pure.gguf}"

HOST="${HOST:-127.0.0.1}"
GRPC_PORT="${GRPC_PORT:-50161}"
HTTP_PORT="${HTTP_PORT:-8181}"
THREADS="${THREADS:-4}"
CTX="${CTX:-2048}"
NGL="${NGL:-99}"
NMAX="${NMAX:-4}"
FLASH_ATTN="${FLASH_ATTN:-on}"
TIMEOUT_S="${TIMEOUT_S:-180}"

LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dspark-e2e.XXXXXX")"

for f in "$DAEMON" "$SERVER" "$TARGET_MODEL" "$DRAFT_MODEL"; do
    if [ ! -f "$f" ]; then
        echo "e2e: missing $f (build with 'just build', fetch models with 'just models')" >&2
        exit 1
    fi
done

cleanup() {
    [ -n "${DAEMON_PID:-}" ] && kill "$DAEMON_PID" 2>/dev/null || true
    [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

fail() {
    echo "e2e: FAIL: $1" >&2
    echo "--- daemon log tail ---" >&2
    tail -20 "$LOG_DIR/daemon.log" >&2 || true
    echo "--- server log tail ---" >&2
    tail -30 "$LOG_DIR/server.log" >&2 || true
    exit 1
}

echo "e2e: logs in $LOG_DIR"

"$DAEMON" \
    --model "$DRAFT_MODEL" \
    --host "$HOST" --port "$GRPC_PORT" \
    --threads "$THREADS" --ctx-size "$CTX" \
    > "$LOG_DIR/daemon.log" 2>&1 &
DAEMON_PID=$!

sleep 1
kill -0 "$DAEMON_PID" 2>/dev/null || fail "daemon exited during startup"

"$SERVER" \
    -m "$TARGET_MODEL" \
    --host "$HOST" --port "$HTTP_PORT" \
    --ctx-size "$CTX" --n-gpu-layers "$NGL" --flash-attn "$FLASH_ATTN" \
    --parallel 1 \
    --spec-type draft-remote-dspark \
    --spec-draft-remote-grpc "$HOST:$GRPC_PORT" \
    --spec-draft-n-max "$NMAX" \
    --temp 0 --top-k 1 \
    > "$LOG_DIR/server.log" 2>&1 &
SERVER_PID=$!

echo "e2e: waiting for server (max ${TIMEOUT_S}s)..."
for _ in $(seq 1 "$TIMEOUT_S"); do
    kill -0 "$SERVER_PID" 2>/dev/null || fail "server exited during startup"
    if curl -s --max-time 2 "http://$HOST:$HTTP_PORT/health" | grep -q '"ok"\|ok'; then
        break
    fi
    sleep 1
done
curl -s --max-time 2 "http://$HOST:$HTTP_PORT/health" | grep -q 'ok' || fail "server never became healthy"

echo "e2e: 1/3 /v1/completions"
R1=$(curl -s --max-time 300 "http://$HOST:$HTTP_PORT/v1/completions" \
    -H 'Content-Type: application/json' \
    -d '{"prompt":"The capital of France is","max_tokens":24,"temperature":0}') \
    || fail "completions request failed"
echo "$R1" | grep -q '"text"' || fail "completions: no text in response: $R1"
DRAFT_N=$(echo "$R1" | sed -n 's/.*"draft_n":\([0-9]*\).*/\1/p')
[ -n "$DRAFT_N" ] && [ "$DRAFT_N" -gt 0 ] || fail "completions: no draft tokens generated (draft_n=${DRAFT_N:-missing})"

echo "e2e: 2/3 /v1/chat/completions (slot reuse)"
R2=$(curl -s --max-time 300 "http://$HOST:$HTTP_PORT/v1/chat/completions" \
    -H 'Content-Type: application/json' \
    -d '{"messages":[{"role":"user","content":"In one word, what is the capital of France?"}],"max_tokens":32,"temperature":0}') \
    || fail "chat request failed"
echo "$R2" | grep -q '"content"' || fail "chat: no content in response: $R2"
kill -0 "$SERVER_PID" 2>/dev/null || fail "server crashed on second request"

echo "e2e: 3/3 /debug/spec"
SPEC=$(curl -s --max-time 10 "http://$HOST:$HTTP_PORT/debug/spec") || fail "debug/spec request failed"
echo "$SPEC" | grep -q '"remote_dspark":"connected"' || fail "drafter not connected: $SPEC"
BLOCKS=$(echo "$SPEC" | sed -n 's/.*"draft_blocks":\([0-9]*\).*/\1/p')
[ -n "$BLOCKS" ] && [ "$BLOCKS" -gt 0 ] || fail "no draft blocks recorded: $SPEC"

echo ""
echo "e2e: PASS"
echo "  completions draft_n = $DRAFT_N"
echo "  spec stats: $SPEC"
