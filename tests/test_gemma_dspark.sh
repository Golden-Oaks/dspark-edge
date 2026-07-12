#!/usr/bin/env bash
# Gemma4 DSpark ("dspark" arch) test suite.
#
# Runs the checkpoint-free converter/gguf-py tests always, and — when the built
# daemon and the Gemma draft GGUF are present — a real end-to-end graph smoke test
# (load + encoder + K/V injection + noise decoder + fused Markov/confidence head +
# sampling). Also runs the Qwen3 golden replay as a regression guard when those
# artifacts are available.
#
# Usage: tests/test_gemma_dspark.sh
set -uo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

DAEMON="$ROOT/build/tools/llama-dspark-grpcd/llama-dspark-grpcd"
GEMMA_DRAFT="$ROOT/models/dspark_gemma4_12b_q4pure.gguf"
QWEN_DRAFT="$ROOT/models/dspark_qwen3_4b_block7.gguf"
QWEN_TARGET="$ROOT/models/Qwen3-4B-Q8_0.gguf"
GOLDEN="$ROOT/golden"

PY="${PYTHON:-python3}"
if [ -d "$ROOT/.venv" ]; then
    # shellcheck disable=SC1091
    source "$ROOT/.venv/bin/activate" 2>/dev/null || true
fi

rc=0

echo "== converter / gguf-py tests =="
"$PY" "$ROOT/tests/test_gemma_dspark_convert.py" || rc=1

echo
echo "== Gemma DSpark graph smoke test (--selftest) =="
if [ -x "$DAEMON" ] && [ -f "$GEMMA_DRAFT" ]; then
    "$DAEMON" --model "$GEMMA_DRAFT" --selftest --ctx-size 512 --threads 4 \
        2>&1 | grep -iE "selftest|drafted|PASS|error|non-finite" || true
    # propagate the daemon's exit code
    "$DAEMON" --model "$GEMMA_DRAFT" --selftest --ctx-size 512 --threads 4 >/dev/null 2>&1 || rc=1
else
    echo "  skip: daemon or Gemma draft not present ($DAEMON / $GEMMA_DRAFT)"
fi

echo
echo "== Qwen3 golden-replay regression =="
if [ -x "$DAEMON" ] && [ -f "$QWEN_DRAFT" ] && [ -f "$QWEN_TARGET" ] && [ -d "$GOLDEN" ]; then
    "$DAEMON" --model "$QWEN_DRAFT" --target-model "$QWEN_TARGET" \
        --replay "$GOLDEN" --ctx-size 512 --threads 4 2>&1 | grep -iE "parity|EXACT|completed" | tail -3
    "$DAEMON" --model "$QWEN_DRAFT" --target-model "$QWEN_TARGET" \
        --replay "$GOLDEN" --ctx-size 512 --threads 4 >/dev/null 2>&1 || rc=1
else
    echo "  skip: Qwen3 draft/target or golden dir not present"
fi

echo
if [ "$rc" -eq 0 ]; then
    echo "GEMMA DSPARK TESTS: PASS"
else
    echo "GEMMA DSPARK TESTS: FAIL"
fi
exit "$rc"
