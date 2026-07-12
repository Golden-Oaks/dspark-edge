#include "grpc_service.h"

#include <chrono>

#include "log.h"

namespace dspark {

namespace {

uint64_t now_us() {
    return (uint64_t)std::chrono::duration_cast<std::chrono::microseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
}

template <typename T>
std::vector<token_features> unpack_tokens(const T & proto_tokens) {
    std::vector<token_features> out;
    out.reserve(proto_tokens.size());
    for (const auto & pt : proto_tokens) {
        token_features tf;
        tf.token = pt.token();
        tf.position = pt.position();
        tf.features.assign(pt.features().begin(), pt.features().end());
        out.push_back(std::move(tf));
    }
    return out;
}

} // namespace

dspark_service_impl::dspark_service_impl(dspark_engine_factory factory,
                                         std::shared_ptr<watch_renderer> renderer)
    : factory_(std::move(factory))
    , renderer_(std::move(renderer)) {
}

grpc::Status dspark_service_impl::InitSession(
    grpc::ServerContext * /*context*/,
    const InitSessionRequest * request,
    InitSessionResponse * response) {

    if (request->target_model_id().empty()) {
        response->set_ok(false);
        response->set_message("target_model_id required");
        return grpc::Status::OK;
    }

    auto engine = factory_();
    if (!engine || !engine->init()) {
        response->set_ok(false);
        response->set_message("failed to initialize DSpark engine");
        return grpc::Status::OK;
    }

    const auto & cfg = engine->config();

    std::lock_guard<std::mutex> lock(sessions_mtx_);
    uint64_t sid = next_session_id_++;
    auto s = std::make_unique<session>();
    s->id = sid;
    s->engine = std::move(engine);
    sessions_[sid] = std::move(s);

    response->set_session_id(sid);
    response->set_ok(true);
    response->set_message("session created");
    response->set_draft_model_id(cfg.draft_model_id);
    for (int32_t lid : cfg.target_layer_ids) {
        response->add_target_layer_ids((uint32_t)lid);
    }
    response->set_hidden_size((uint32_t)cfg.hidden_size);
    response->set_block_size((uint32_t)cfg.block_size);
    response->set_feature_dtype(cfg.feature_dtype);

    LOG_INF("[dspark-grpc] InitSession sid=%lu target=%s draft=%s layers=%zu\n",
            (unsigned long)sid, request->target_model_id().c_str(),
            cfg.draft_model_id.c_str(), cfg.target_layer_ids.size());

    return grpc::Status::OK;
}

grpc::Status dspark_service_impl::Prefill(
    grpc::ServerContext * /*context*/,
    const PrefillRequest * request,
    PrefillResponse * response) {

    auto * s = get_session(request->session_id());
    if (!s) {
        response->set_ok(false);
        return grpc::Status::OK;
    }

    std::lock_guard<std::mutex> lock(s->mtx);
    auto tokens = unpack_tokens(request->tokens());
    if (renderer_) {
        std::vector<int32_t> toks;
        toks.reserve(tokens.size());
        for (const auto & tf : tokens) toks.push_back(tf.token);
        renderer_->on_accepted(toks);
    }
    uint64_t n_positions = 0;
    bool ok = s->engine->prefill(tokens, n_positions);

    response->set_ok(ok);
    response->set_n_positions(n_positions);
    return grpc::Status::OK;
}

grpc::Status dspark_service_impl::Draft(
    grpc::ServerContext * /*context*/,
    const DraftRequest * request,
    DraftResponse * response) {

    auto * s = get_session(request->session_id());
    if (!s) {
        response->set_ok(false);
        response->set_error("session not found");
        return grpc::Status::OK;
    }

    std::lock_guard<std::mutex> lock(s->mtx);

    if (request->step_id() <= s->last_step_id) {
        response->set_ok(false);
        response->set_error("stale step_id");
        return grpc::Status::OK;
    }
    s->last_step_id = request->step_id();

    draft_request req;
    req.session_id = request->session_id();
    req.step_id    = request->step_id();
    req.position   = request->position();
    req.max_draft_tokens = request->max_draft_tokens();
    req.greedy     = request->greedy();
    req.anchor_token = request->anchor_token();
    req.accepted_tokens = unpack_tokens(request->accepted_tokens());

    draft_response res = s->engine->draft(req);

    response->set_session_id(res.session_id);
    response->set_step_id(res.step_id);
    response->set_ok(res.ok);
    response->set_error(res.error);
    response->set_draft_us(res.draft_us);

    for (int32_t tok : res.draft_tokens) {
        response->add_draft_tokens(tok);
    }
    for (float lp : res.draft_logprobs) {
        response->add_draft_logprobs(lp);
    }
    for (float c : res.confidence) {
        response->add_confidence(c);
    }

    // Notify the (asynchronous) preview renderer last. on_verdict/on_draft only
    // enqueue events, so this never delays the response the server is waiting on.
    if (renderer_) {
        // Verdict first: settle the previous pending region with accepted tokens.
        std::vector<int32_t> accepted;
        accepted.reserve(req.accepted_tokens.size());
        for (const auto & tf : req.accepted_tokens) accepted.push_back(tf.token);
        renderer_->on_verdict(accepted);
        // Then show the new pending draft.
        renderer_->on_draft(res.draft_tokens);
    }

    return grpc::Status::OK;
}

grpc::Status dspark_service_impl::Reset(
    grpc::ServerContext * /*context*/,
    const ResetRequest * request,
    ResetResponse * response) {

    std::lock_guard<std::mutex> lock(sessions_mtx_);
    auto it = sessions_.find(request->session_id());
    if (it == sessions_.end()) {
        response->set_ok(false);
        return grpc::Status::OK;
    }

    {
        std::lock_guard<std::mutex> slock(it->second->mtx);
        it->second->engine->reset();
    }
    if (renderer_) renderer_->on_reset();

    response->set_ok(true);
    return grpc::Status::OK;
}

dspark_service_impl::session * dspark_service_impl::get_session(uint64_t id) {
    std::lock_guard<std::mutex> lock(sessions_mtx_);
    auto it = sessions_.find(id);
    return it == sessions_.end() ? nullptr : it->second.get();
}

} // namespace dspark
