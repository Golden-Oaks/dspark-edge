#pragma once

// Abstract DSpark drafter interface used by the server's speculative backend.
// This file is intended to be added to common/ in the llama.cpp submodule.

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

struct dspark_token_features {
    int32_t  token;
    uint64_t position;
    std::vector<uint8_t> features; // n_tap_layers * hidden_size * dtype_size
};

struct remote_dspark_request {
    uint64_t session_id;
    uint64_t step_id;
    uint64_t position;             // truncate draft KV beyond this first
    int32_t  max_draft_tokens;
    bool     greedy;
    int32_t  anchor_token = 0;     // id_last: token the draft block anchors on
    std::vector<dspark_token_features> accepted_tokens;
};

struct remote_dspark_response {
    uint64_t session_id;
    uint64_t step_id;
    std::vector<int32_t> draft_tokens;
    std::vector<float>   draft_logprobs;
    std::vector<float>   confidence;
    uint32_t draft_us = 0;
    bool     ok = false;
    std::string error;
};

class dspark_drafter {
public:
    virtual ~dspark_drafter() = default;

    // Send prompt hidden states to build the draft KV cache.
    virtual bool prefill(const std::vector<dspark_token_features> & tokens, bool last_chunk) = 0;

    // Run one draft step from accepted-token features.
    virtual remote_dspark_response draft(const remote_dspark_request & req) = 0;

    // Reset / end the session.
    virtual bool reset() = 0;
};

// Local in-process DSpark drafter (the existing path, refactored).
class local_dspark_drafter final : public dspark_drafter {
public:
    // TODO: wrap the existing common_speculative_impl_draft_dflash(is_dspark=true).
    bool prefill(const std::vector<dspark_token_features> & /*tokens*/, bool /*last_chunk*/) override {
        return true;
    }
    remote_dspark_response draft(const remote_dspark_request & /*req*/) override {
        return {};
    }
    bool reset() override {
        return true;
    }
};

// gRPC client drafter that talks to llama-dspark-grpcd.
class grpc_dspark_drafter final : public dspark_drafter {
public:
    explicit grpc_dspark_drafter(const std::string & target);
    ~grpc_dspark_drafter() override;

    bool init(const std::string & target_model_id, const std::string & tokenizer_hash,
              std::vector<int32_t> & out_target_layer_ids,
              int32_t & out_hidden_size,
              int32_t & out_block_size,
              std::string & out_feature_dtype);

    bool prefill(const std::vector<dspark_token_features> & tokens, bool last_chunk) override;
    bool reset() override;

    remote_dspark_response draft(const remote_dspark_request & req) override;

    bool healthy() const;
    uint64_t session_id() const;

private:
    struct impl;
    std::unique_ptr<impl> pimpl;
};
