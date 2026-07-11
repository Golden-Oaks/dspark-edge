#pragma once

#include <memory>
#include <mutex>
#include <unordered_map>

#include "dspark_engine.h"
#include "dspark.grpc.pb.h"
#include "watch_renderer.h"

namespace dspark {

class dspark_service_impl final : public DSparkDraftService::Service {
public:
    explicit dspark_service_impl(dspark_engine_factory factory,
                                 std::shared_ptr<watch_renderer> renderer = nullptr);

    grpc::Status InitSession(
        grpc::ServerContext * context,
        const InitSessionRequest * request,
        InitSessionResponse * response) override;

    grpc::Status Prefill(
        grpc::ServerContext * context,
        const PrefillRequest * request,
        PrefillResponse * response) override;

    grpc::Status Draft(
        grpc::ServerContext * context,
        const DraftRequest * request,
        DraftResponse * response) override;

    grpc::Status Reset(
        grpc::ServerContext * context,
        const ResetRequest * request,
        ResetResponse * response) override;

private:
    struct session {
        uint64_t id;
        dspark_engine_ptr engine;
        std::mutex mtx;
        uint64_t last_step_id = 0;
    };

    dspark_engine_factory factory_;
    std::shared_ptr<watch_renderer> renderer_;
    std::mutex sessions_mtx_;
    std::unordered_map<uint64_t, std::unique_ptr<session>> sessions_;
    uint64_t next_session_id_ = 1;

    session * get_session(uint64_t id);
    void proto_to_features(const DraftRequest & req, std::vector<token_features> & out);
    void proto_to_features(const PrefillRequest & req, std::vector<token_features> & out);
};

} // namespace dspark
