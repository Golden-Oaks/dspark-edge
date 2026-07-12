cmake_minimum_required(VERSION 3.16)
project(dspark-edging VERSION 0.1.0 LANGUAGES CXX C)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Force llama.cpp to build its common library. The edge daemon links llama-common.
set(LLAMA_BUILD_COMMON ON CACHE BOOL "" FORCE)

# On the QNX edge device we build only the drafter daemon (llama-dspark-grpcd),
# not the host-side llama-server. Building the llama.cpp tools there is both
# unnecessary and pulls in host-only deps (httplib/curl), so disable them.
if(CMAKE_SYSTEM_NAME STREQUAL "QNX")
    set(LLAMA_BUILD_TOOLS  OFF CACHE BOOL "" FORCE)
    set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
else()
    set(LLAMA_BUILD_TOOLS  ON CACHE BOOL "" FORCE)
    # llama-server is the host-side target for --spec-type draft-remote-dspark.
    # As a subdirectory build LLAMA_BUILD_SERVER defaults off, so force it on.
    set(LLAMA_BUILD_SERVER ON CACHE BOOL "" FORCE)
endif()

# gRPC / Protobuf
find_package(Protobuf CONFIG QUIET)
find_package(gRPC CONFIG QUIET)

if(NOT Protobuf_FOUND OR NOT gRPC_FOUND)
    find_package(PkgConfig REQUIRED)
    pkg_check_modules(PROTOBUF protobuf REQUIRED)
    pkg_check_modules(GRPC grpc++ REQUIRED)
endif()

# Add llama.cpp as a subdirectory. This defines `llama`, `llama-common`, etc.
add_subdirectory(third_party/llama.cpp)

# Our edge daemon.
add_subdirectory(tools/llama-dspark-grpcd)

