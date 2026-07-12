# dspark-edge task runner. `just` lists recipes.
#
# Typical flow on a fresh checkout (macOS or Linux):
#   just init      # submodule + llama.cpp patches
#   just build     # llama-server + llama-dspark-grpcd
#   just models    # fetch the gemma4 target + DSpark draft GGUFs
#   just e2e       # end-to-end spec-decode test against a live two-process demo
#
# macOS deps: brew install cmake grpc protobuf

set shell := ["bash", "-euo", "pipefail", "-c"]

build_dir := env_var_or_default("BUILD_DIR", "build")
models_dir := env_var_or_default("MODELS_DIR", "models")

# Gemma 4 12B pair: no conversion step needed, both are ready-made GGUFs.
target_gguf := models_dir + "/gemma-4-12B-it-Q4_K_M.gguf"
draft_gguf := models_dir + "/dspark_gemma4_12b_q4pure.gguf"
target_url := "https://huggingface.co/ggml-org/gemma-4-12B-it-GGUF/resolve/main/gemma-4-12B-it-Q4_K_M.gguf"
draft_url := "https://huggingface.co/ankk98/dspark-gemma4-12b-block7-Q4_0-GGUF/resolve/main/dspark_gemma4_12b_q4pure.gguf"

default:
    @just --list

# Initialize the llama.cpp submodule and apply all DSpark patches.
init:
    ./scripts/init.sh

# Build both llama-server (target host) and llama-dspark-grpcd (edge daemon).
build:
    ./scripts/build.sh

# Build only the patched llama-server.
build-server:
    cmake --build {{build_dir}} --target llama-server -j"$(getconf _NPROCESSORS_ONLN)"

# Build only the edge drafter daemon (the gRPC client device binary).
build-daemon:
    cmake --build {{build_dir}} --target llama-dspark-grpcd -j"$(getconf _NPROCESSORS_ONLN)"

# Download the Gemma 4 12B target + DSpark draft GGUFs (~9.3 GB total).
models:
    mkdir -p {{models_dir}}
    [ -f {{draft_gguf}} ] || curl -L --fail --retry 3 -o {{draft_gguf}} {{draft_url}}
    [ -f {{target_gguf}} ] || curl -L --fail --retry 3 -o {{target_gguf}} {{target_url}}
    ls -la {{models_dir}}

# Run the two-process localhost demo (edge daemon + server) in the foreground.
# Metal on Apple silicon by default; NGL=0 FLASH_ATTN=off for CPU-only.
demo:
    TARGET_MODEL={{target_gguf}} DRAFT_MODEL={{draft_gguf}} \
    NGL="${NGL:-99}" FLASH_ATTN="${FLASH_ATTN:-on}" CTX="${CTX:-2048}" NMAX="${NMAX:-4}" \
    ./scripts/run_demo.sh

# End-to-end test: boots daemon + server, exercises /v1/completions and
# /v1/chat/completions, and asserts the remote drafter actually drafted.
e2e:
    TARGET_MODEL={{target_gguf}} DRAFT_MODEL={{draft_gguf}} ./tests/e2e_demo.sh

# Remove build artifacts (keeps models).
clean:
    rm -rf {{build_dir}}
