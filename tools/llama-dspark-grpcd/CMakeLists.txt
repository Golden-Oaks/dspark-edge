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

set(PROTO_DIR ${CMAKE_SOURCE_DIR}/proto)
set(PROTO_FILE ${PROTO_DIR}/dspark.proto)
set(GENERATED_DIR ${CMAKE_BINARY_DIR}/generated)
file(MAKE_DIRECTORY ${GENERATED_DIR})

add_custom_command(
    OUTPUT
        ${GENERATED_DIR}/dspark.pb.cc
        ${GENERATED_DIR}/dspark.pb.h
        ${GENERATED_DIR}/dspark.grpc.pb.cc
        ${GENERATED_DIR}/dspark.grpc.pb.h
    COMMAND ${Protobuf_PROTOC_EXECUTABLE}
        --grpc_out=${GENERATED_DIR}
        --cpp_out=${GENERATED_DIR}
        --proto_path=${PROTO_DIR}
        --plugin=protoc-gen-grpc=${GRPC_CPP_PLUGIN}
        ${PROTO_FILE}
    DEPENDS ${PROTO_FILE}
)

add_library(dspark_proto STATIC
    ${GENERATED_DIR}/dspark.pb.cc
    ${GENERATED_DIR}/dspark.grpc.pb.cc
)
target_include_directories(dspark_proto PUBLIC ${GENERATED_DIR})
target_link_libraries(dspark_proto PUBLIC ${PROTOBUF_LIB} ${GRPC_GRPCPP})

add_executable(${TARGET}
    main.cpp
    grpc_service.cpp
    dspark_engine.cpp
    watch_renderer.cpp
    replay_mode.cpp
)

target_include_directories(${TARGET} PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_SOURCE_DIR}/third_party/llama.cpp/include
    ${CMAKE_SOURCE_DIR}/third_party/llama.cpp/common
    ${CMAKE_SOURCE_DIR}/third_party/llama.cpp/src
    ${CMAKE_SOURCE_DIR}/third_party/llama.cpp/ggml/include
)

target_link_libraries(${TARGET} PRIVATE
    dspark_proto
    llama-common
    llama
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
