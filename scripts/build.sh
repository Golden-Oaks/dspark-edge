#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Apply server-side patches if they haven't been applied yet.
if [ ! -f third_party/llama.cpp/common/dspark_drafter.h ]; then
    echo "Applying remote-dspark server patches..."
    ./scripts/init.sh
fi

BUILD_DIR="${BUILD_DIR:-build}"
mkdir -p "$BUILD_DIR"

cmake -S . -B "$BUILD_DIR" \
    -DCMAKE_BUILD_TYPE=Release \
    -DLLAMA_BUILD_COMMON=ON \
    -DLLAMA_BUILD_TOOLS=ON \
    -DLLAMA_CURL=OFF \
    "$@"

cmake --build "$BUILD_DIR" --target llama-dspark-grpcd llama-server -j$(nproc)

echo "Built binaries:"
echo "  $BUILD_DIR/tools/llama-dspark-grpcd/llama-dspark-grpcd"
echo "  $BUILD_DIR/bin/llama-server"
