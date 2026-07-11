#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

BUILD_DIR="${BUILD_DIR:-build}"
DAEMON="$BUILD_DIR/tools/llama-dspark-grpcd/llama-dspark-grpcd"
SERVER="$BUILD_DIR/bin/llama-server"

MODELS_DIR="${MODELS_DIR:-models}"
TARGET_MODEL="${TARGET_MODEL:-$MODELS_DIR/Qwen3-4B-Q4_K_M.gguf}"
DRAFT_MODEL="${DRAFT_MODEL:-$MODELS_DIR/dspark_qwen3_4b_block7.gguf}"

if [ ! -f "$DAEMON" ]; then
    echo "error: daemon not built. run ./scripts/build.sh first"
    exit 1
fi
if [ ! -f "$SERVER" ]; then
    echo "error: server not built. run ./scripts/build.sh first"
    exit 1
fi
if [ ! -f "$TARGET_MODEL" ]; then
    echo "error: target model not found: $TARGET_MODEL"
    exit 1
fi
if [ ! -f "$DRAFT_MODEL" ]; then
    echo "error: draft model not found: $DRAFT_MODEL"
    exit 1
fi

# Start edge daemon.
"$DAEMON" \
    --model "$DRAFT_MODEL" \
    --host 127.0.0.1 \
    --port 50051 \
    --threads 4 \
    --watch &
DAEMON_PID=$!

# Wait for daemon to come up.
sleep 1

# Start patched llama-server.
"$SERVER" \
    -m "$TARGET_MODEL" \
    --host 127.0.0.1 \
    --port 8080 \
    --ctx-size 4096 \
    --n-gpu-layers 99 \
    --flash-attn on \
    --parallel 1 \
    --spec-type draft-remote-dspark \
    --spec-draft-remote-grpc 127.0.0.1:50051 \
    --spec-draft-n-max 7 \
    --temp 0 \
    --top-k 1 &
SERVER_PID=$!

echo "daemon PID: $DAEMON_PID"
echo "server PID: $SERVER_PID"
echo ""
echo "Send a request with:"
echo "  curl http://127.0.0.1:8080/v1/chat/completions -H 'Content-Type: application/json' -d '{\"messages\":[{\"role\":\"user\",\"content\":\"Hello\"}]}'"
echo ""
echo "Press Ctrl-C to stop."
wait
