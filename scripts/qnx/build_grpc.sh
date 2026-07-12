#!/bin/sh
# Build gRPC (C++) natively on the QNX 8.0 target for the DSpark edge daemon.
#
# gRPC is not available as a QNX apk package, but the qnx-ports project
# maintains a QNX 8 fork (https://github.com/qnx-ports/grpc, tag qnx-v1.65.0)
# with the platform patches needed to compile. We build it natively on-target
# against the apk-provided OpenSSL, and let gRPC build its own pinned protobuf /
# abseil / re2 / c-ares / zlib from submodules (the "module" providers) so the
# whole stack is version-consistent (gRPC 1.65 <-> protobuf 27.2).
#
# Prereqs: scripts/qnx/install_deps.sh
# Output:  $PREFIX (default $HOME/work/grpc-install) with libgrpc++, protoc and
#          grpc_cpp_plugin. Point the daemon build at it via GRPC_PREFIX.
set -e

GRPC_TAG="${GRPC_TAG:-qnx-v1.65.0}"
SRC="${GRPC_SRC:-$HOME/work/grpc}"
PREFIX="${GRPC_PREFIX:-$HOME/work/grpc-install}"
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 4)}"

if [ ! -d "$SRC" ]; then
    git clone --depth 1 -b "$GRPC_TAG" https://github.com/qnx-ports/grpc.git "$SRC"
fi
cd "$SRC"
# Only the submodules actually needed for a C++ build with module providers.
git submodule update --init --recursive --depth 1 \
    third_party/abseil-cpp third_party/protobuf third_party/re2 \
    third_party/cares/cares third_party/zlib \
    third_party/xds third_party/envoy-api third_party/googleapis \
    third_party/protoc-gen-validate third_party/opencensus-proto

rm -rf cmake-build && mkdir -p cmake-build && cd cmake-build
# CMAKE_POLICY_VERSION_MINIMUM=3.5: several vendored deps still declare a
# cmake_minimum_required below what CMake 4.x accepts by default.
cmake .. -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
    -DBUILD_SHARED_LIBS=ON \
    -DgRPC_INSTALL=ON \
    -DCMAKE_INSTALL_PREFIX="$PREFIX" \
    -DgRPC_SSL_PROVIDER=package \
    -DgRPC_PROTOBUF_PROVIDER=module \
    -DgRPC_ABSL_PROVIDER=module \
    -DgRPC_RE2_PROVIDER=module \
    -DgRPC_ZLIB_PROVIDER=module \
    -DgRPC_CARES_PROVIDER=module \
    -DgRPC_BUILD_TESTS=OFF \
    -DgRPC_BUILD_GRPC_CPP_PLUGIN=ON \
    -DgRPC_BUILD_GRPC_CSHARP_PLUGIN=OFF -DgRPC_BUILD_GRPC_NODE_PLUGIN=OFF \
    -DgRPC_BUILD_GRPC_OBJECTIVE_C_PLUGIN=OFF -DgRPC_BUILD_GRPC_PHP_PLUGIN=OFF \
    -DgRPC_BUILD_GRPC_PYTHON_PLUGIN=OFF -DgRPC_BUILD_GRPC_RUBY_PLUGIN=OFF \
    -DABSL_PROPAGATE_CXX_STD=ON \
    -DCMAKE_C_FLAGS='-D_QNX_SOURCE' -DCMAKE_CXX_FLAGS='-D_QNX_SOURCE'

# Build the default target set (not just grpc++): gRPC's install manifest
# references libs like grpc_unsecure, so a restricted --target list makes
# `cmake --install` fail with "cannot find libgrpc_unsecure.so".
cmake --build . -j"$JOBS"
cmake --install .

echo "gRPC installed to $PREFIX"
