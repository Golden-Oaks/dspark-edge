#!/bin/sh
# Build the DSpark edge daemon (llama-dspark-grpcd) natively on the QNX 8.0
# target. Only the daemon is built here -- the host-side llama-server is a
# Linux component (the top-level CMakeLists disables LLAMA_BUILD_TOOLS on QNX).
#
# Prereqs: scripts/qnx/install_deps.sh and scripts/qnx/build_grpc.sh
# ARM flags match the qnx-ports llama.cpp port (Cortex-A76 / Pi 5):
#   armv8.2-a + dotprod + fp16.
set -e

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
GRPC_PREFIX="${GRPC_PREFIX:-$HOME/work/grpc-install}"
BUILD_DIR="${BUILD_DIR:-build-qnx}"
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 4)}"

cd "$ROOT"

# init.sh generated common/dspark.{pb,grpc.pb}.* with whatever protoc is on PATH
# (apk protobuf, a different major version than gRPC's bundled 27.2). Regenerate
# them with gRPC's own protoc so the generated code matches the libprotobuf the
# daemon links -- otherwise llama-common fails to compile the stale headers.
echo "Regenerating common/ proto with gRPC's protoc ($GRPC_PREFIX)..."
LD_LIBRARY_PATH="$GRPC_PREFIX/lib" "$GRPC_PREFIX/bin/protoc" -I proto \
    --cpp_out=third_party/llama.cpp/common \
    --grpc_out=third_party/llama.cpp/common \
    --plugin=protoc-gen-grpc="$GRPC_PREFIX/bin/grpc_cpp_plugin" \
    proto/dspark.proto

rm -rf "$BUILD_DIR" && mkdir -p "$BUILD_DIR" && cd "$BUILD_DIR"
# GGML_CPU_REPACK=OFF: the aarch64 weight-repack path allocates a second full
# copy of the model weights, and the daemon loads BOTH the draft and the (much
# larger) target model just to borrow its embedding/output tensors. On an 8 GB
# Pi 5 that doubling OOMs on the ~4 GB Q8 target. The daemon never runs the
# target's GEMMs, so the repack buys nothing here.
cmake .. -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
    -DCMAKE_PREFIX_PATH="$GRPC_PREFIX" \
    -DProtobuf_DIR="$GRPC_PREFIX/lib/cmake/protobuf" \
    -DgRPC_DIR="$GRPC_PREFIX/lib/cmake/grpc" \
    -DGGML_NATIVE=OFF \
    -DGGML_OPENMP=OFF \
    -DGGML_CPU_ARM_ARCH=armv8.2-a+dotprod+fp16 \
    -DGGML_CPU_REPACK=OFF \
    -DLLAMA_CURL=OFF \
    -DLLAMA_BUILD_TESTS=OFF \
    -DLLAMA_BUILD_EXAMPLES=OFF \
    -DCMAKE_C_FLAGS='-D_QNX_SOURCE' -DCMAKE_CXX_FLAGS='-D_QNX_SOURCE'

cmake --build . --target llama-dspark-grpcd -j"$JOBS"

echo "Built: $BUILD_DIR/tools/llama-dspark-grpcd/llama-dspark-grpcd"
echo "Run with: LD_LIBRARY_PATH=$GRPC_PREFIX/lib $BUILD_DIR/tools/llama-dspark-grpcd/llama-dspark-grpcd --help"
