#pragma once

// Remote DSpark speculative implementation.
// This file is intended to be inserted into common/speculative.cpp.

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "dspark_drafter.h"

// Server-side remote DSpark drafter.
// This file is included into common/speculative.cpp after the base class and
// common_speculative_draft_params types are defined; no extra forward
// declarations are needed.
// Extracts tap-layer hidden states from the target context and sends them
// to an edge daemon over gRPC.
struct common_speculative_impl_draft_remote_dspark : public common_speculative_impl {
    common_params_speculative_draft params;

    std::unique_ptr<dspark_drafter> drafter;

    // Tap-layer configuration from InitSession handshake.
    std::vector<int32_t> target_layer_ids;
    int32_t hidden_size = 0;
    int32_t block_size = 0;
    std::string feature_dtype;

    // Target context and model.
    llama_context * ctx_tgt = nullptr;

    // Buffers for features extracted from the target context.
    std::vector<dspark_token_features> prefill_buf;
    std::vector<dspark_token_features> accepted_buf;

    // State machine.
    bool in_prefill = true;
    bool prefill_sent = false;
    uint64_t last_position = 0; // last confirmed position sent to edge
    uint64_t step_id = 0;

    // Scratch buffer for concatenated float features [n_tokens, n_embd_enc].
    std::vector<float> features_buf;

    common_speculative_impl_draft_remote_dspark(const common_params_speculative & params, uint32_t n_seq)
        : common_speculative_impl(COMMON_SPECULATIVE_TYPE_DRAFT_REMOTE_DSPARK, n_seq)
        , params(params.draft)
        , ctx_tgt(params.draft.ctx_tgt) {
        GGML_ASSERT(ctx_tgt && "draft-remote-dspark requires ctx_tgt");

        drafter = std::make_unique<grpc_dspark_drafter>(params.draft.remote_grpc);

        const llama_model * model_tgt = llama_get_model(ctx_tgt);
        char desc_buf[256] = {};
        llama_model_desc(model_tgt, desc_buf, sizeof(desc_buf));
        const std::string target_model_id = desc_buf;
        // TODO: compute tokenizer hash
        const std::string tokenizer_hash = "";

        bool ok = static_cast<grpc_dspark_drafter *>(drafter.get())->init(
            target_model_id, tokenizer_hash,
            target_layer_ids, hidden_size, block_size, feature_dtype);
        if (!ok) {
            LOG_ERR("%s: failed to initialize remote DSpark session\n", __func__);
            drafter.reset();
            return;
        }

        // Enable extraction of the tap layers' input embeddings.
        for (int32_t lid : target_layer_ids) {
            llama_set_embeddings_layer_inp(ctx_tgt, (uint32_t)lid, true);
        }

        // silence unused-parameter warning for n_seq (POC is single-seq)
        (void)n_seq;

        LOG_INF("%s: remote DSpark session ok, target_layer_ids=%zu hidden_size=%d block_size=%d\n",
                __func__, target_layer_ids.size(), hidden_size, block_size);
    }

    ~common_speculative_impl_draft_remote_dspark() override = default;

    void begin(llama_seq_id /*seq_id*/, const llama_tokens & /*prompt*/) override {
        in_prefill = true;
        prefill_sent = false;
        prefill_buf.clear();
        accepted_buf.clear();
        last_position = 0;
        step_id = 0;
        if (drafter) {
            drafter->reset();
        }
    }

    bool process(const llama_batch & batch_in) override {
        if (!drafter || batch_in.n_tokens <= 0) {
            return true;
        }

        if (batch_in.token == nullptr || batch_in.embd != nullptr) {
            return true;
        }

        const int32_t n_embd_enc = (int32_t)target_layer_ids.size() * hidden_size;
        const int32_t n_tokens = batch_in.n_tokens;

        features_buf.resize((size_t)n_tokens * n_embd_enc);
        for (size_t k = 0; k < target_layer_ids.size(); ++k) {
            const float * layer = llama_get_embeddings_layer_inp(ctx_tgt, (uint32_t)target_layer_ids[k]);
            if (!layer) {
                LOG_ERR("%s: target layer %d input not extracted\n", __func__, target_layer_ids[k]);
                return false;
            }
            for (int32_t i = 0; i < n_tokens; ++i) {
                float * dst = features_buf.data() + (size_t)i * n_embd_enc + (size_t)k * hidden_size;
                const float * src = layer + (size_t)i * hidden_size;
                std::memcpy(dst, src, (size_t)hidden_size * sizeof(float));
            }
        }

        auto & buf = in_prefill ? prefill_buf : accepted_buf;
        for (int32_t i = 0; i < n_tokens; ++i) {
            dspark_token_features tf;
            tf.token = batch_in.token[i];
            tf.position = (uint64_t)batch_in.pos[i];
            // Pack as bf16.
            const size_t n_values = (size_t)target_layer_ids.size() * (size_t)hidden_size;
            tf.features.resize(n_values * sizeof(uint16_t));
            for (size_t v = 0; v < n_values; ++v) {
                float f = features_buf[(size_t)i * n_values + v];
                uint32_t u32;
                std::memcpy(&u32, &f, sizeof(uint32_t));
                uint16_t u16 = (uint16_t)(u32 >> 16);
                std::memcpy(tf.features.data() + v * sizeof(uint16_t), &u16, sizeof(uint16_t));
            }
            buf.push_back(std::move(tf));
        }

        return true;
    }

    void draft(common_speculative_draft_params_vec & dparams) override {
        if (!drafter) {
            return;
        }

        if (in_prefill) {
            // Send the prompt features in one or more Prefill calls.
            // For the POC, send all at once.
            drafter->prefill(prefill_buf, /*last_chunk*/ true);
            if (!prefill_buf.empty()) {
                last_position = prefill_buf.back().position;
            }
            prefill_buf.clear();
            in_prefill = false;
            prefill_sent = true;
        }

        remote_dspark_request req;
        req.session_id = 0; // not used by grpc client
        req.step_id    = ++step_id;
        req.position   = last_position;
        req.max_draft_tokens = std::min(params.n_max, block_size);
        req.greedy     = true;
        req.accepted_tokens = std::move(accepted_buf);

        remote_dspark_response res = drafter->draft(req);
        if (!res.ok) {
            LOG_ERR("%s: remote draft failed: %s\n", __func__, res.error.c_str());
            return;
        }

        // Update last_position to the most recent accepted token.
        if (!req.accepted_tokens.empty()) {
            last_position = req.accepted_tokens.back().position;
        }

        for (llama_seq_id seq_id = 0; seq_id < (llama_seq_id)n_seq; ++seq_id) {
            auto & dp = dparams[seq_id];
            if (!dp.drafting) {
                continue;
            }
            for (int32_t tok : res.draft_tokens) {
                dp.result->push_back((llama_token)tok);
            }
        }
    }

    void accept(llama_seq_id /*seq_id*/, uint16_t /*n_accepted*/, bool /*is_other*/) override {
        // noop
    }

    bool need_embd() const override {
        return true;
    }
};
