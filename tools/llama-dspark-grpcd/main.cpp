#include <cstdio>
#include <cstdlib>
#include <memory>
#include <string>
#include <thread>

#include <grpcpp/server_builder.h>

#include "common.h"
#include "llama.h"
#include "log.h"

#include "dspark_engine.h"
#include "grpc_service.h"
#include "replay_mode.h"
#include "selftest.h"
#include "watch_renderer.h"

using namespace dspark;

namespace {

struct cmdline_args {
    std::string model_path;
    std::string target_model_path;
    std::string host = "0.0.0.0";
    int port = 50051;
    int n_threads = 4;
    int n_ctx = 4096;
    bool watch = false;
    bool selftest = false;
    std::string replay_dir;
};

void print_usage(const char * prog) {
    std::fprintf(stderr,
        "usage: %s [options]\n"
        "  --model PATH      DSpark GGUF model path (required)\n"
        "  --target-model PATH  Target model GGUF path (required for DFlash arch)\n"
        "  --host HOST       gRPC bind host (default: 0.0.0.0)\n"
        "  --port PORT       gRPC bind port (default: 50051)\n"
        "  --threads N       number of threads (default: 4)\n"
        "  --ctx-size N      context size (default: 4096)\n"
        "  --watch           render live speculation preview\n"
        "  --replay DIR      replay golden trace files and exit\n"
        "  --selftest        drive the engine with synthetic features and exit\n"
        "  -h, --help        show this help\n",
        prog);
}

cmdline_args parse_args(int argc, char ** argv) {
    cmdline_args args;
    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if ((arg == "--model" || arg == "-m") && i + 1 < argc) {
            args.model_path = argv[++i];
        } else if (arg == "--target-model" && i + 1 < argc) {
            args.target_model_path = argv[++i];
        } else if (arg == "--host" && i + 1 < argc) {
            args.host = argv[++i];
        } else if (arg == "--port" && i + 1 < argc) {
            args.port = std::atoi(argv[++i]);
        } else if (arg == "--threads" && i + 1 < argc) {
            args.n_threads = std::atoi(argv[++i]);
        } else if (arg == "--ctx-size" && i + 1 < argc) {
            args.n_ctx = std::atoi(argv[++i]);
        } else if (arg == "--watch") {
            args.watch = true;
        } else if (arg == "--selftest") {
            args.selftest = true;
        } else if (arg == "--replay" && i + 1 < argc) {
            args.replay_dir = argv[++i];
        } else if (arg == "--help" || arg == "-h") {
            print_usage(argv[0]);
            std::exit(0);
        } else {
            std::fprintf(stderr, "unknown argument: %s\n", arg.c_str());
            print_usage(argv[0]);
            std::exit(1);
        }
    }
    return args;
}

std::unique_ptr<dspark_engine> make_engine(llama_model * model, llama_context * ctx_target, const cmdline_args & args) {
    llama_context_params ctx_params = llama_context_default_params();
    ctx_params.n_ctx = args.n_ctx;
    ctx_params.n_threads = args.n_threads;
    ctx_params.n_threads_batch = args.n_threads;
    // DSpark uses non-causal attention; keep flash attention disabled to
    // avoid surprises with the dual-mode decoder graph.
    ctx_params.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_DISABLED;
    // DFlash shares token embeddings and output head with the target model.
    ctx_params.ctx_other = ctx_target;

    llama_context * ctx = llama_init_from_model(model, ctx_params);
    if (!ctx) {
        LOG_ERR("[main] failed to create llama context\n");
        return nullptr;
    }

    return std::make_unique<dspark_engine>(model, ctx);
}

} // namespace

int main(int argc, char ** argv) {
    cmdline_args args = parse_args(argc, argv);
    if (args.model_path.empty()) {
        std::fprintf(stderr, "error: --model is required\n");
        print_usage(argv[0]);
        return 1;
    }

    llama_backend_init();
    llama_numa_init(GGML_NUMA_STRATEGY_DISABLED);

    llama_model_params model_params = llama_model_default_params();
    model_params.n_gpu_layers = 0; // edge daemon is CPU-only
    model_params.split_mode = LLAMA_SPLIT_MODE_NONE;

    llama_model * model = llama_model_load_from_file(args.model_path.c_str(), model_params);
    if (!model) {
        LOG_ERR("[main] failed to load model: %s\n", args.model_path.c_str());
        return 1;
    }

    llama_model * model_tgt = nullptr;
    llama_context * ctx_tgt = nullptr;
    if (!args.target_model_path.empty()) {
        model_tgt = llama_model_load_from_file(args.target_model_path.c_str(), model_params);
        if (!model_tgt) {
            LOG_ERR("[main] failed to load target model: %s\n", args.target_model_path.c_str());
            llama_model_free(model);
            return 1;
        }
        llama_context_params tgt_ctx_params = llama_context_default_params();
        tgt_ctx_params.n_ctx = args.n_ctx;
        tgt_ctx_params.n_threads = args.n_threads;
        tgt_ctx_params.n_threads_batch = args.n_threads;
        ctx_tgt = llama_init_from_model(model_tgt, tgt_ctx_params);
        if (!ctx_tgt) {
            LOG_ERR("[main] failed to create target context\n");
            llama_model_free(model_tgt);
            llama_model_free(model);
            return 1;
        }
    }

    // Replay mode: create a single engine, replay golden traces, and exit.
    if (!args.replay_dir.empty()) {
        auto engine = make_engine(model, ctx_tgt, args);
        if (!engine || !engine->init()) {
            LOG_ERR("[main] failed to initialize DSpark engine\n");
            llama_model_free(model);
            return 1;
        }
        int rc = replay_golden(*engine, args.replay_dir);
        llama_free(ctx_tgt);
        llama_model_free(model_tgt);
        llama_model_free(model);
        return rc;
    }

    // Self-test mode: create a single engine, drive it with synthetic features, and exit.
    if (args.selftest) {
        auto engine = make_engine(model, ctx_tgt, args);
        if (!engine || !engine->init()) {
            LOG_ERR("[main] failed to initialize DSpark engine\n");
            llama_free(ctx_tgt);
            llama_model_free(model_tgt);
            llama_model_free(model);
            return 1;
        }
        int rc = run_selftest(*engine);
        llama_free(ctx_tgt);
        llama_model_free(model_tgt);
        llama_model_free(model);
        return rc;
    }

    // Optional watch renderer. Shared pointer so the service can notify it.
    std::shared_ptr<watch_renderer> renderer;
    if (args.watch) {
        renderer = std::make_shared<watch_renderer>(model);
    }

    // Factory creates a new engine per session. For now we share the same
    // model; each session gets its own context.
    dspark_engine_factory factory = [&]() {
        return make_engine(model, ctx_tgt, args);
    };

    dspark_service_impl service(factory, renderer);

    std::string server_address = args.host + ":" + std::to_string(args.port);
    grpc::ServerBuilder builder;
    builder.AddListeningPort(server_address, grpc::InsecureServerCredentials());
    builder.RegisterService(&service);

    std::unique_ptr<grpc::Server> server(builder.BuildAndStart());
    LOG_INF("[main] llama-dspark-grpcd listening on %s\n", server_address.c_str());

    server->Wait();

    llama_free(ctx_tgt);
    llama_model_free(model_tgt);
    llama_model_free(model);
    llama_backend_free();
    return 0;
}
