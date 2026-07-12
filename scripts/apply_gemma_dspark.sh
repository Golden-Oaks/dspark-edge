#!/usr/bin/env bash
# Apply the Gemma4 DSpark ("dspark" arch) support patch to the llama.cpp submodule.
#
# This adds a new LLM_ARCH_DSPARK (Gemma4 backbone: scaled embeddings, k_eq_v
# attention, attn_scale=1.0, post-attn/post-ffw norms, GELU FFN, proportional RoPE,
# logit softcap) alongside the existing Qwen3 "dflash" arch, plus the gguf-py and
# convert_hf_to_gguf.py support (Gemma4DSparkModel). See patches/gemma_dspark_llamacpp.patch.
#
# Idempotent: a no-op if the arch is already present. Run from the repo root
# (invoked automatically by scripts/init.sh).
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
LLAMA="$ROOT/third_party/llama.cpp"
PATCH="$ROOT/patches/gemma_dspark_llamacpp.patch"

if [ ! -d "$LLAMA" ]; then
    echo "error: $LLAMA not found; run 'git submodule update --init' first" >&2
    exit 1
fi

# Already applied?
if grep -q "LLM_ARCH_DSPARK" "$LLAMA/src/llama-arch.h" 2>/dev/null; then
    echo "gemma-dspark: already applied"
    exit 0
fi

if git -C "$LLAMA" apply --check "$PATCH" 2>/dev/null; then
    git -C "$LLAMA" apply "$PATCH"
    echo "gemma-dspark: patch applied"
else
    echo "error: patches/gemma_dspark_llamacpp.patch does not apply cleanly to the current submodule" >&2
    exit 1
fi
