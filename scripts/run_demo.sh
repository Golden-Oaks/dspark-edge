#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Two-process localhost demo: edge daemon (DSpark draft) + patched llama-server
# (target) over gRPC. Fully env-parameterized so it works for either model family
# and on CPU or GPU.
#
# Qwen3 (GPU):
#   MODELS_DIR=models ./scripts/run_demo.sh
#
# Gemma 4 12B, quantized target, CPU-only:
#   TARGET_MODEL=models/gemma-4-12b-it-Q4_0.gguf \
#   DRAFT_MODEL=models/dspark_gemma4_12b_q4pure.gguf \
#   NGL=0 FLASH_ATTN=off CTX=512 NMAX=4 \
#   ./scripts/run_demo.sh

BUILD_DIR="${BUILD_DIR:-build}"
DAEMON="$BUILD_DIR/tools/llama-dspark-grpcd/llama-dspark-grpcd"
SERVER="$BUILD_DIR/bin/llama-server"

MODELS_DIR="${MODELS_DIR:-models}"
TARGET_MODEL="${TARGET_MODEL:-$MODELS_DIR/Qwen3-4B-Q4_K_M.gguf}"
DRAFT_MODEL="${DRAFT_MODEL:-$MODELS_DIR/dspark_qwen3_4b_block7.gguf}"

# Runtime knobs (override per model / hardware).
HOST="${HOST:-127.0.0.1}"
GRPC_PORT="${GRPC_PORT:-50051}"
HTTP_PORT="${HTTP_PORT:-8080}"
THREADS="${THREADS:-4}"
CTX="${CTX:-4096}"          # context size (baseline uses 512)
NGL="${NGL:-99}"           # target GPU layers; set NGL=0 for CPU-only
NMAX="${NMAX:-7}"          # max draft tokens per block (<= draft block_size)
FLASH_ATTN="${FLASH_ATTN:-on}"  # set FLASH_ATTN=off for CPU

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

echo "target: $TARGET_MODEL"
echo "draft:  $DRAFT_MODEL"
echo "ngl=$NGL flash_attn=$FLASH_ATTN ctx=$CTX n_max=$NMAX"
echo ""

cleanup() {
    [ -n "${DAEMON_PID:-}" ] && kill "$DAEMON_PID" 2>/dev/null || true
    [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Start edge daemon.
"$DAEMON" \
    --model "$DRAFT_MODEL" \
    --host "$HOST" \
    --port "$GRPC_PORT" \
    --threads "$THREADS" \
    --ctx-size "$CTX" &
DAEMON_PID=$!

# Wait for the daemon to come up before the server handshakes with it.
sleep 1

# Start patched llama-server.
"$SERVER" \
    -m "$TARGET_MODEL" \
    --host "$HOST" \
    --port "$HTTP_PORT" \
    --ctx-size "$CTX" \
    --n-gpu-layers "$NGL" \
    --flash-attn "$FLASH_ATTN" \
    --parallel 1 \
    --spec-type draft-remote-dspark \
    --spec-draft-remote-grpc "$HOST:$GRPC_PORT" \
    --spec-draft-n-max "$NMAX" \
    --temp 0 \
    --top-k 1 &
SERVER_PID=$!

echo "daemon PID: $DAEMON_PID"
echo "server PID: $SERVER_PID"
echo ""
echo "Send a request with:"
echo "  curl http://$HOST:$HTTP_PORT/v1/completions -H 'Content-Type: application/json' \\"
echo "    -d '{\"prompt\":\"The capital of France is\",\"n_predict\":24,\"temperature\":0}'"
echo "Edge stats: curl http://$HOST:$HTTP_PORT/debug/spec"
echo ""
echo "Press Ctrl-C to stop."
wait
