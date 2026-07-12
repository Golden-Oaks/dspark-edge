#!/bin/sh
# Install the QNX 8.0 build dependencies for the DSpark edge daemon.
#
# Run this ON the QNX target (Raspberry Pi 5, aarch64le). It uses apk against
# the QNX OSS package repo (https://oss.qnx.com). gRPC itself is NOT packaged
# there, so it is built separately by scripts/qnx/build_grpc.sh; everything it
# needs (protobuf, abseil, c-ares, re2, openssl, zlib) IS available via apk.
set -e

sudo apk update
sudo apk add \
    protobuf-dev abseil-cpp-dev c-ares-dev re2-dev \
    openssl-dev zlib-ng-dev \
    cmake ninja make git

echo "QNX build dependencies installed."
