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

echo "Initialized and patched llama.cpp."
