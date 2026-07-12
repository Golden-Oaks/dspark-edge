#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

git submodule update --init third_party/llama.cpp

cd third_party/llama.cpp
# Pin to the DSpark PR head commit.
PIN=27cc3bae61b1d00db07e8fa0f02b23c5fee30ab9
if [ "$(git rev-parse HEAD)" != "$PIN" ]; then
    git fetch --depth 1 origin "$PIN" || true
    git checkout "$PIN"
fi
cd ../..

# Gemma4 DSpark ("dspark" arch) support (applied before the remote server patch;
# the remote patch's speculative.cpp edits are string-based and stack on top).
./scripts/apply_gemma_dspark.sh

python3 server_patches/apply_remote_dspark.py

# QNX portability fixes for llama.cpp (aarch64le arch detection, syspage memory
# query, getcwd backend-search path, <limits.h> includes). Mirrors the official
# qnx-ports llama.cpp port (github.com/qnx-ports/build-files PR #290). Harmless
# on Linux (all hunks are __QNX__-guarded or cross-platform). --forward makes
# re-runs a no-op.
patch -p1 -d third_party/llama.cpp --forward --fuzz=3 < patches/qnx_llamacpp.patch || true

echo "Initialized and patched llama.cpp."
