#include "dspark_drafter.h"

#include <grpcpp/grpcpp.h>

#include "dspark.grpc.pb.h"

struct grpc_dspark_drafter::impl {
    std::unique_ptr<dspark::DSparkDraftService::Stub> stub;
    uint64_t session_id = 0;
    bool initialized = false;
};

grpc_dspark_drafter::grpc_dspark_drafter(const std::string & target)
    : pimpl(std::make_unique<impl>()) {
    pimpl->stub = dspark::DSparkDraftService::NewStub(
        grpc::CreateChannel(target, grpc::InsecureChannelCredentials()));
}

grpc_dspark_drafter::~grpc_dspark_drafter() = default;

bool grpc_dspark_drafter::init(const std::string & target_model_id,
                               const std::string & tokenizer_hash,
                               std::vector<int32_t> & out_target_layer_ids,
                               int32_t & out_hidden_size,
                               int32_t & out_block_size,
                               std::string & out_feature_dtype) {
    dspark::InitSessionRequest req;
    req.set_target_model_id(target_model_id);
    req.set_tokenizer_hash(tokenizer_hash);

    dspark::InitSessionResponse resp;
    grpc::ClientContext ctx;
    grpc::Status status = pimpl->stub->InitSession(&ctx, req, &resp);
    if (!status.ok() || !resp.ok()) {
        return false;
    }

    pimpl->session_id = resp.session_id();
    pimpl->initialized = true;

    out_target_layer_ids.clear();
    for (uint32_t lid : resp.target_layer_ids()) {
        out_target_layer_ids.push_back((int32_t)lid);
    }
    out_hidden_size   = (int32_t)resp.hidden_size();
    out_block_size    = (int32_t)resp.block_size();
    out_feature_dtype = resp.feature_dtype();
    return true;
}

bool grpc_dspark_drafter::healthy() const {
    return pimpl->initialized && pimpl->stub;
}

uint64_t grpc_dspark_drafter::session_id() const {
    return pimpl->session_id;
}

bool grpc_dspark_drafter::prefill(const std::vector<dspark_token_features> & tokens, bool last_chunk) {
    if (!pimpl->initialized) return false;
    dspark::PrefillRequest grpc_req;
    grpc_req.set_session_id(pimpl->session_id);
    grpc_req.set_last_chunk(last_chunk);
    for (const auto & tf : tokens) {
        auto * pt = grpc_req.add_tokens();
        pt->set_token(tf.token);
        pt->set_position(tf.position);
        pt->set_features(tf.features.data(), tf.features.size());
    }
    dspark::PrefillResponse resp;
    grpc::ClientContext ctx;
    grpc::Status status = pimpl->stub->Prefill(&ctx, grpc_req, &resp);
    return status.ok() && resp.ok();
}

bool grpc_dspark_drafter::reset() {
    if (!pimpl->initialized) return false;
    dspark::ResetRequest grpc_req;
    grpc_req.set_session_id(pimpl->session_id);
    dspark::ResetResponse resp;
    grpc::ClientContext ctx;
    grpc::Status status = pimpl->stub->Reset(&ctx, grpc_req, &resp);
    pimpl->initialized = false;
    return status.ok() && resp.ok();
}

remote_dspark_response grpc_dspark_drafter::draft(const remote_dspark_request & req) {
    remote_dspark_response res;
    if (!pimpl->initialized) {
        res.error = "not initialized";
        return res;
    }

    dspark::DraftRequest grpc_req;
    grpc_req.set_session_id(pimpl->session_id);
    grpc_req.set_step_id(req.step_id);
    grpc_req.set_position(req.position);
    grpc_req.set_max_draft_tokens(req.max_draft_tokens);
    grpc_req.set_greedy(req.greedy);

    for (const auto & tf : req.accepted_tokens) {
        auto * pt = grpc_req.add_accepted_tokens();
        pt->set_token(tf.token);
        pt->set_position(tf.position);
        pt->set_features(tf.features.data(), tf.features.size());
    }

    dspark::DraftResponse grpc_resp;
    grpc::ClientContext ctx;
    grpc::Status status = pimpl->stub->Draft(&ctx, grpc_req, &grpc_resp);

    res.session_id = grpc_resp.session_id();
    res.step_id    = grpc_resp.step_id();
    res.ok         = status.ok() && grpc_resp.ok();
    res.error      = !status.ok() ? status.error_message() : grpc_resp.error();
    res.draft_us   = grpc_resp.draft_us();

    for (int32_t tok : grpc_resp.draft_tokens()) {
        res.draft_tokens.push_back(tok);
    }
    for (float lp : grpc_resp.draft_logprobs()) {
        res.draft_logprobs.push_back(lp);
    }
    for (float c : grpc_resp.confidence()) {
        res.confidence.push_back(c);
    }

    return res;
}
