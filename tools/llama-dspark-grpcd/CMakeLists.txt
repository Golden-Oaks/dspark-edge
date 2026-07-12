cmake_minimum_required(VERSION 3.16)

set(TARGET llama-dspark-grpcd)

find_package(Protobuf CONFIG QUIET)
find_package(gRPC CONFIG QUIET)

if(Protobuf_FOUND AND gRPC_FOUND)
    set(PROTOBUF_LIB protobuf::libprotobuf)
    set(GRPC_GRPCPP gRPC::grpc++)
    get_target_property(GRPC_CPP_PLUGIN gRPC::grpc_cpp_plugin LOCATION)
    if(NOT GRPC_CPP_PLUGIN OR GRPC_CPP_PLUGIN STREQUAL "GRPC_CPP_PLUGIN-NOTFOUND")
        set(GRPC_CPP_PLUGIN $<TARGET_FILE:gRPC::grpc_cpp_plugin>)
    endif()
    if(NOT Protobuf_PROTOC_EXECUTABLE)
        set(Protobuf_PROTOC_EXECUTABLE $<TARGET_FILE:protobuf::protoc>)
    endif()
else()
    find_package(PkgConfig REQUIRED)
    pkg_check_modules(PROTOBUF protobuf REQUIRED)
    pkg_check_modules(GRPC grpc++ REQUIRED)
    set(PROTOBUF_LIB ${PROTOBUF_LIBRARIES})
    set(GRPC_GRPCPP ${GRPC_LIBRARIES})
    find_program(Protobuf_PROTOC_EXECUTABLE protoc REQUIRED)
    find_program(GRPC_CPP_PLUGIN grpc_cpp_plugin REQUIRED)
endif()

# The generated dspark.pb.cc / dspark.grpc.pb.cc are compiled into llama-common
# (server_patches/apply_remote_dspark.py generates them into llama.cpp/common/).
# The daemon must NOT compile its own copy: when llama-common is a shared
# library (the llama.cpp default), both copies' global initializers run and
# protobuf aborts at startup with "File already exists in database:
# dspark.proto". Link llama-common's objects instead; the headers are on the
# llama-common public include path.

add_executable(${TARGET}
    main.cpp
    grpc_service.cpp
    dspark_engine.cpp
    watch_renderer.cpp
    replay_mode.cpp
    selftest.cpp
)

target_include_directories(${TARGET} PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_SOURCE_DIR}/third_party/llama.cpp/include
    ${CMAKE_SOURCE_DIR}/third_party/llama.cpp/common
    ${CMAKE_SOURCE_DIR}/third_party/llama.cpp/src
    ${CMAKE_SOURCE_DIR}/third_party/llama.cpp/ggml/include
)

target_link_libraries(${TARGET} PRIVATE
    llama-common
    llama
    ${PROTOBUF_LIB}
    ${GRPC_GRPCPP}
)

if(GRPC_FOUND AND NOT gRPC_FOUND)
    target_include_directories(${TARGET} PRIVATE ${GRPC_INCLUDE_DIRS})
    target_compile_options(${TARGET} PRIVATE ${GRPC_CFLAGS_OTHER})
endif()

set_target_properties(${TARGET} PROPERTIES
    CXX_STANDARD 17
    CXX_STANDARD_REQUIRED ON
)
