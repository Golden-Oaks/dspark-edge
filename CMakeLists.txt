cmake_minimum_required(VERSION 3.16)
project(dspark-edging VERSION 0.1.0 LANGUAGES CXX C)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Force llama.cpp to build its common library and tools so we get llama-server.
set(LLAMA_BUILD_COMMON ON CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TOOLS ON CACHE BOOL "" FORCE)

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

