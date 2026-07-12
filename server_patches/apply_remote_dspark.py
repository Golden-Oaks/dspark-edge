#!/usr/bin/env python3
"""
Apply the draft-remote-dspark server patch to the llama.cpp submodule.

This script modifies files under third_party/llama.cpp in place:
  - common/common.h              add enum entry + params field + need_n_rs_seq
  - common/speculative.cpp       add remote drafter impl + wiring
  - common/arg.cpp               add --spec-draft-remote-grpc flag
  - tools/server/server-schema.cpp add schema entry
  - common/CMakeLists.txt        add dspark_drafter files + gRPC link
  - tools/server/CMakeLists.txt  add gRPC link

Run from the repo root:
  python3 server_patches/apply_remote_dspark.py
"""

import os
import re
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LLAMA = os.path.join(ROOT, "third_party", "llama.cpp")
PATCH = os.path.join(ROOT, "server_patches")


def read(path):
    with open(path, "r") as f:
        return f.read()


def write(path, data):
    with open(path, "w") as f:
        f.write(data)


def report(label, changed):
    print(f"{'patched' if changed else 'unchanged'} {label}")


def patch_common_h():
    path = os.path.join(LLAMA, "common", "common.h")
    s = read(path)

    # Add enum entry after DRAFT_DSPARK.
    needle = "COMMON_SPECULATIVE_TYPE_DRAFT_DSPARK,  // DSpark speculative decoding (DFlash + Markov head)"
    if needle in s and "COMMON_SPECULATIVE_TYPE_DRAFT_REMOTE_DSPARK" not in s:
        s = s.replace(
            needle,
            needle + "\n"
            "    COMMON_SPECULATIVE_TYPE_DRAFT_REMOTE_DSPARK, // remote DSpark drafter over gRPC",
        )

    # Add params field after conf_min.
    if "remote_grpc" not in s:
        s = s.replace(
            "    float conf_min = 0.0f; // DSpark: min predicted acceptance from the confidence head (0 = disabled)",
            "    float conf_min = 0.0f; // DSpark: min predicted acceptance from the confidence head (0 = disabled)\n"
            "\n"
            "    std::string remote_grpc; // draft-remote-dspark: edge daemon host:port",
        )

    # Update need_n_rs_seq lambda.
    old_lambda = (
        "return t == COMMON_SPECULATIVE_TYPE_DRAFT_MTP || "
        "t == COMMON_SPECULATIVE_TYPE_DRAFT_EAGLE3 || "
        "t == COMMON_SPECULATIVE_TYPE_DRAFT_DFLASH || "
        "t == COMMON_SPECULATIVE_TYPE_DRAFT_DSPARK;"
    )
    new_lambda = (
        "return t == COMMON_SPECULATIVE_TYPE_DRAFT_MTP || "
        "t == COMMON_SPECULATIVE_TYPE_DRAFT_EAGLE3 || "
        "t == COMMON_SPECULATIVE_TYPE_DRAFT_DFLASH || "
        "t == COMMON_SPECULATIVE_TYPE_DRAFT_DSPARK || "
        "t == COMMON_SPECULATIVE_TYPE_DRAFT_REMOTE_DSPARK;"
    )
    if old_lambda in s:
        s = s.replace(old_lambda, new_lambda)

    write(path, s)
    report("common/common.h", True)


def patch_speculative_cpp():
    path = os.path.join(LLAMA, "common", "speculative.cpp")
    s = read(path)

    # Type string maps.
    if "draft-remote-dspark" not in s:
        s = s.replace(
            '{"draft-dspark",  COMMON_SPECULATIVE_TYPE_DRAFT_DSPARK},',
            '{"draft-dspark",  COMMON_SPECULATIVE_TYPE_DRAFT_DSPARK},\n'
            '    {"draft-remote-dspark", COMMON_SPECULATIVE_TYPE_DRAFT_REMOTE_DSPARK},',
        )
        s = s.replace(
            "case COMMON_SPECULATIVE_TYPE_DRAFT_DSPARK:  return \"draft-dspark\";",
            "case COMMON_SPECULATIVE_TYPE_DRAFT_DSPARK:  return \"draft-dspark\";\n"
            "        case COMMON_SPECULATIVE_TYPE_DRAFT_REMOTE_DSPARK: return \"draft-remote-dspark\";",
        )

    # static_assert count bump (idempotent: set to expected value after adding the enum).
    if "COMMON_SPECULATIVE_TYPE_DRAFT_REMOTE_DSPARK" in s:
        s = re.sub(
            r"static_assert\(COMMON_SPECULATIVE_TYPE_COUNT == \d+\);",
            "static_assert(COMMON_SPECULATIVE_TYPE_COUNT == 12);",
            s,
            count=1,
        )

    # init config: add has_draft_remote_dspark.
    if "has_draft_remote_dspark" not in s:
        s = s.replace(
            "bool has_draft_dspark = (enabled_configs & (1u << COMMON_SPECULATIVE_TYPE_DRAFT_DSPARK)) && params.draft.ctx_dft != nullptr;",
            "bool has_draft_dspark = (enabled_configs & (1u << COMMON_SPECULATIVE_TYPE_DRAFT_DSPARK)) && params.draft.ctx_dft != nullptr;\n"
            "        bool has_draft_remote_dspark = (enabled_configs & (1u << COMMON_SPECULATIVE_TYPE_DRAFT_REMOTE_DSPARK)) && !params.draft.remote_grpc.empty();",
        )
        s = s.replace(
            "if (has_draft_dspark) {\n            configs.push_back(common_speculative_config(COMMON_SPECULATIVE_TYPE_DRAFT_DSPARK, params));\n        }",
            "if (has_draft_dspark) {\n"
            "            configs.push_back(common_speculative_config(COMMON_SPECULATIVE_TYPE_DRAFT_DSPARK, params));\n"
            "        }\n"
            "        if (has_draft_remote_dspark) {\n"
            "            configs.push_back(common_speculative_config(COMMON_SPECULATIVE_TYPE_DRAFT_REMOTE_DSPARK, params));\n"
            "        }",
        )

    # Add includes for our drafter abstraction and remote impl.
    inc_drafter = '#include "dspark_drafter.h"\n'
    inc_impl = '#include "remote_dspark_impl.h"\n'
    if inc_drafter not in s:
        s = s.replace('#include "common.h"\n', '#include "common.h"\n' + inc_drafter, 1)
    if inc_impl not in s:
        # Insert after the DFlash/DSpark class definition (closing brace + semicolon).
        marker = "struct common_speculative_impl_draft_mtp : public common_speculative_impl {"
        if marker in s:
            s = s.replace(marker, inc_impl + marker, 1)

    # Add remote DSpark to n_max switch.
    n_max_block = '''            case COMMON_SPECULATIVE_TYPE_DRAFT_DFLASH:
            case COMMON_SPECULATIVE_TYPE_DRAFT_DSPARK:
                n_max = std::max(n_max, std::max(0, spec->draft.n_max));
                break;'''
    n_max_block_new = '''            case COMMON_SPECULATIVE_TYPE_DRAFT_DFLASH:
            case COMMON_SPECULATIVE_TYPE_DRAFT_DSPARK:
            case COMMON_SPECULATIVE_TYPE_DRAFT_REMOTE_DSPARK:
                n_max = std::max(n_max, std::max(0, spec->draft.n_max));
                break;'''
    if n_max_block in s:
        s = s.replace(n_max_block, n_max_block_new)

    # Add switch case for remote DSpark in common_speculative_init.
    if "common_speculative_impl_draft_remote_dspark" not in s:
        marker = "case COMMON_SPECULATIVE_TYPE_NGRAM_SIMPLE: {"
        insert = (
            "            case COMMON_SPECULATIVE_TYPE_DRAFT_REMOTE_DSPARK: {\n"
            "                impls.push_back(std::make_unique<common_speculative_impl_draft_remote_dspark>(config.params, n_seq));\n"
            "                break;\n"
            "            }\n"
            "            "
        )
        if marker in s:
            s = s.replace("            " + marker, insert + marker)

    # Accept the Gemma4 "dspark" arch's block-size key in the local draft-dspark
    # path (the Qwen3 draft uses "dflash.block_size"; the Gemma draft uses
    # "dspark.block_size"). Harmless for the remote path.
    old_bs = (
        '            if (llama_model_meta_val_str(model_dft, "dflash.block_size", buf, sizeof(buf)) >= 0) {'
    )
    new_bs = (
        '            if (llama_model_meta_val_str(model_dft, "dspark.block_size", buf, sizeof(buf)) >= 0 ||\n'
        '                llama_model_meta_val_str(model_dft, "dflash.block_size", buf, sizeof(buf)) >= 0) {'
    )
    if 'dspark.block_size' not in s and old_bs in s:
        s = s.replace(old_bs, new_bs)

    write(path, s)
    report("common/speculative.cpp", True)


def patch_arg_cpp():
    path = os.path.join(LLAMA, "common", "arg.cpp")
    s = read(path)

    insert = '''    add_opt(common_arg(
        {"--spec-draft-remote-grpc"}, "HOST:PORT",
        "remote DSpark drafter gRPC target (default: none)",
        [](common_params & params, const std::string & value) {
            params.speculative.draft.remote_grpc = value;
        }
    ).set_spec().set_examples({LLAMA_EXAMPLE_SPECULATIVE, LLAMA_EXAMPLE_SERVER, LLAMA_EXAMPLE_CLI}).set_env("LLAMA_ARG_SPEC_DRAFT_REMOTE_GRPC"));
'''
    if "--spec-draft-remote-grpc" not in s:
        s = s.replace(
            '    add_opt(common_arg(\n        {"--spec-draft-conf-min"}, "P",',
            insert + '    add_opt(common_arg(\n        {"--spec-draft-conf-min"}, "P",',
        )
    write(path, s)
    report("common/arg.cpp", True)


def patch_server_schema():
    path = os.path.join(LLAMA, "tools", "server", "server-schema.cpp")
    if not os.path.exists(path):
        print("skip tools/server/server-schema.cpp (not present)")
        return
    s = read(path)
    if "draft-remote-dspark" not in s:
        s = s.replace(
            "\"draft-dspark\",",
            "\"draft-dspark\",\"draft-remote-dspark\",",
        )
    write(path, s)
    report("tools/server/server-schema.cpp", True)


def generate_proto_to_common():
    dst_common = os.path.join(LLAMA, "common")
    proto_file = os.path.join(ROOT, "proto", "dspark.proto")
    protoc = os.environ.get("PROTOC", "protoc")
    grpc_plugin = os.environ.get("GRPC_CPP_PLUGIN")
    if not grpc_plugin:
        import shutil
        grpc_plugin = shutil.which("grpc_cpp_plugin") or "grpc_cpp_plugin"
    cmd = [
        protoc,
        f"--grpc_out={dst_common}",
        f"--cpp_out={dst_common}",
        f"--proto_path={os.path.dirname(proto_file)}",
        f"--plugin=protoc-gen-grpc={grpc_plugin}",
        proto_file,
    ]
    import subprocess
    subprocess.check_call(cmd)
    print(f"generated dspark.pb.h / dspark.grpc.pb.h into common/")


def copy_drafter_files():
    dst_common = os.path.join(LLAMA, "common")
    shutil.copy(os.path.join(PATCH, "dspark_drafter.h"), dst_common)
    shutil.copy(os.path.join(PATCH, "dspark_stats.h"), dst_common)
    shutil.copy(os.path.join(PATCH, "remote_dspark_client.cpp"), dst_common)
    shutil.copy(os.path.join(PATCH, "remote_dspark_impl.h"), dst_common)
    generate_proto_to_common()
    print("copied dspark_drafter.h, dspark_stats.h, remote_dspark_client.cpp, remote_dspark_impl.h to common/")


def patch_debug_spec_endpoint():
    # 1) add the handler member to server_routes
    ctx_h = os.path.join(LLAMA, "tools", "server", "server-context.h")
    s = read(ctx_h)
    if "get_debug_spec" not in s:
        s = s.replace(
            "    server_http_context::handler_t get_metrics;",
            "    server_http_context::handler_t get_metrics;\n"
            "    server_http_context::handler_t get_debug_spec;",
            1,
        )
        write(ctx_h, s)
    report("tools/server/server-context.h", True)

    # 2) add the include + handler body in init_routes
    ctx_cpp = os.path.join(LLAMA, "tools", "server", "server-context.cpp")
    s = read(ctx_cpp)
    if '#include "dspark_stats.h"' not in s:
        s = s.replace(
            '#include "server-context.h"\n',
            '#include "server-context.h"\n#include "dspark_stats.h"\n',
            1,
        )
    if "this->get_debug_spec" not in s:
        handler = (
            "    this->get_debug_spec = [this](const server_http_req &) {\n"
            "        auto res = create_response(true);\n"
            "        const auto & st = remote_dspark_stats_get();\n"
            "        const uint64_t blocks = st.draft_blocks.load();\n"
            "        const uint64_t dtoks  = st.draft_tokens.load();\n"
            "        const uint64_t atoks  = st.accepted_tokens.load();\n"
            "        const uint64_t gcalls = st.grpc_calls.load();\n"
            "        const double acc_rate = dtoks  ? (double) atoks / (double) dtoks : 0.0;\n"
            "        const double edge_ms  = blocks ? (double) st.edge_draft_us_sum.load() / (double) blocks / 1000.0 : 0.0;\n"
            "        const double grpc_ms  = gcalls ? (double) st.grpc_us_sum.load() / (double) gcalls / 1000.0 : 0.0;\n"
            "        res->ok({\n"
            '            { \"remote_dspark\",     st.connected.load() ? \"connected\" : \"disconnected\" },\n'
            '            { \"edge_host\",         st.edge_host },\n'
            '            { \"draft_blocks\",      blocks },\n'
            '            { \"draft_tokens\",      dtoks },\n'
            '            { \"accepted_tokens\",   atoks },\n'
            '            { \"acceptance_rate\",   acc_rate },\n'
            '            { \"avg_edge_draft_ms\", edge_ms },\n'
            '            { \"avg_grpc_ms\",       grpc_ms },\n'
            '            { \"fallback_steps\",    st.fallback_steps.load() },\n'
            "        });\n"
            "        return res;\n"
            "    };\n\n"
        )
        s = s.replace(
            "    this->get_metrics = [this](const server_http_req & req) {",
            handler + "    this->get_metrics = [this](const server_http_req & req) {",
            1,
        )
    write(ctx_cpp, s)
    report("tools/server/server-context.cpp (debug/spec)", True)

    # 3) register the route
    srv = os.path.join(LLAMA, "tools", "server", "server.cpp")
    s = read(srv)
    if "/debug/spec" not in s:
        s = s.replace(
            '    ctx_http.get ("/metrics",                  ex_wrapper(routes.get_metrics));',
            '    ctx_http.get ("/metrics",                  ex_wrapper(routes.get_metrics));\n'
            '    ctx_http.get ("/debug/spec",               ex_wrapper(routes.get_debug_spec));',
            1,
        )
    write(srv, s)
    report("tools/server/server.cpp (debug/spec)", True)


def patch_common_cmake():
    path = os.path.join(LLAMA, "common", "CMakeLists.txt")
    s = read(path)

    # Add source files (client + generated proto).
    if "remote_dspark_client.cpp" not in s:
        s = s.replace(
            "speculative.cpp",
            "speculative.cpp\n        remote_dspark_client.cpp",
            1,
        )
    if "dspark.pb.cc" not in s:
        s = s.replace(
            "remote_dspark_client.cpp",
            "remote_dspark_client.cpp\n        dspark.pb.cc\n        dspark.grpc.pb.cc",
            1,
        )

    # Add gRPC link if not present.
    if "gRPC::grpc++" not in s and "find_package(gRPC" not in s:
        # Insert find_package and link near the top of the file.
        s = (
            "find_package(gRPC CONFIG REQUIRED)\n"
            "find_package(Protobuf CONFIG REQUIRED)\n\n"
            + s
        )
        # Append link to the common target.
        s = s.rstrip() + "\n\ntarget_link_libraries(${TARGET} PRIVATE gRPC::grpc++ protobuf::libprotobuf)\n"

    write(path, s)
    report("common/CMakeLists.txt", True)


def patch_server_cmake():
    path = os.path.join(LLAMA, "tools", "server", "CMakeLists.txt")
    if not os.path.exists(path):
        print("skip tools/server/CMakeLists.txt (not present)")
        return
    s = read(path)
    if "gRPC::grpc++" not in s:
        s = s.replace(
            "target_link_libraries(${TARGET} PRIVATE",
            "target_link_libraries(${TARGET} PRIVATE\n    gRPC::grpc++",
            1,
        )
    write(path, s)
    report("tools/server/CMakeLists.txt", True)


def patch_server_ctx_tgt():
    """Wire up ctx_tgt for the remote DSpark drafter.

    The remote drafter has no local draft model, so the target-context handoff
    that the draft/MTP path does must also happen for it: (1) treat a configured
    remote_grpc endpoint as "has spec", and (2) set draft.ctx_tgt before the
    draft-model-loading block (which the remote path skips)."""
    path = os.path.join(LLAMA, "tools", "server", "server-context.cpp")
    s = read(path)

    if "has_remote_dspark" not in s:
        s = s.replace(
            "        const bool has_spec = has_draft || spec_mtp;\n",
            "        const bool has_remote_dspark = !params_base.speculative.draft.remote_grpc.empty();\n"
            "        const bool has_spec = has_draft || spec_mtp || has_remote_dspark;\n",
            1,
        )

    # Set ctx_tgt before, and guard, the draft-model-loading block.
    marker = ("            {\n"
              "                common_params params_dft = common_base_params_to_speculative(params_base);\n")
    if marker in s:
        s = s.replace(
            marker,
            "            params_base.speculative.draft.ctx_tgt = ctx_tgt;\n\n"
            "            // A local draft model (draft/MTP) needs loading here; the remote\n"
            "            // DSpark drafter has no local draft model, so it only needs ctx_tgt\n"
            "            // (set above) and skips this block.\n"
            "            if (has_draft || spec_mtp) {\n"
            "                common_params params_dft = common_base_params_to_speculative(params_base);\n",
            1,
        )
        # Drop the now-duplicate assignment that lived inside the block.
        s = s.replace(
            "                params_base.speculative.draft.ctx_tgt = ctx_tgt;\n"
            "                params_base.speculative.draft.ctx_dft = ctx_dft;\n",
            "                params_base.speculative.draft.ctx_dft = ctx_dft;\n",
            1,
        )

    write(path, s)
    report("tools/server/server-context.cpp (ctx_tgt)", True)


def main():
    if not os.path.isdir(LLAMA):
        print(f"error: {LLAMA} not found; run git submodule update --init first")
        sys.exit(1)

    copy_drafter_files()
    patch_common_h()
    patch_speculative_cpp()
    patch_arg_cpp()
    patch_common_cmake()
    patch_server_schema()
    patch_server_cmake()
    patch_debug_spec_endpoint()
    patch_server_ctx_tgt()
    print("done.")


if __name__ == "__main__":
    main()
