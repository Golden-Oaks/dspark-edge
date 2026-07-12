#pragma once

// Remote DSpark speculative implementation.
// This file is intended to be inserted into common/speculative.cpp.

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "dspark_drafter.h"
#include "dspark_stats.h"
#include "log.h"

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

    // Every token the target has decoded, keyed by its sequence position. The
    // remote drafter needs the target hidden states of the *committed* prefix
    // (positions 0 .. n_past-1) in its local draft KV cache. process() captures
    // features per decoded position here; draft() ships the not-yet-sent ones.
    // Rejected-draft positions are simply never shipped (they get overwritten by
    // the next batch that re-decodes those positions).
    std::map<uint64_t, dspark_token_features> feats;

    // State machine.
    bool     prefilled = false;  // has the prompt prefill been shipped yet
    int64_t  n_sent   = -1;      // highest position already injected into the edge
    int64_t  prev_n_past = -1;   // committed count at the previous draft (for acceptance stats)
    uint64_t step_id  = 0;

    // Scratch buffer for concatenated float features [n_tokens, n_embd_enc].
    std::vector<float> features_buf;

    common_speculative_impl_draft_remote_dspark(const common_params_speculative & params, uint32_t n_seq)
        : common_speculative_impl(COMMON_SPECULATIVE_TYPE_DRAFT_REMOTE_DSPARK, n_seq)
        , params(params.draft)
        , ctx_tgt(params.draft.ctx_tgt) {
        GGML_ASSERT(ctx_tgt && "draft-remote-dspark requires ctx_tgt");
        LOG_ERR("[remote-dspark] ctx_tgt=%p remote_grpc='%s'\n",
                (void*)ctx_tgt, params.draft.remote_grpc.c_str());

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

        // Publish connection state for the /debug/spec endpoint.
        {
            auto & st = remote_dspark_stats_get();
            st.connected = true;
            st.edge_host = params.draft.remote_grpc;
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

    void begin(llama_seq_id /*seq_id*/, const llama_tokens & prompt) override {
        // A new generation begins. process() has already captured this prompt's
        // features into `feats` at positions 0 .. N-1 (it runs before begin()).
        // Reset our send bookkeeping and the edge session, but keep those prompt
        // features so draft() can ship them as the prefill.
        prefilled = false;
        n_sent    = -1;
        prev_n_past = -1;
        step_id   = 0;

        // Drop any stale features left over from a previous, longer generation
        // that would otherwise sit past the new prompt.
        const uint64_t n_prompt = (uint64_t)prompt.size();
        for (auto it = feats.begin(); it != feats.end(); ) {
            if (it->first >= n_prompt) {
                it = feats.erase(it);
            } else {
                ++it;
            }
        }

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

        // Store one feature packet per decoded position, keyed by position so a
        // re-decoded position overwrites its stale value.
        const size_t n_values = (size_t)target_layer_ids.size() * (size_t)hidden_size;
        for (int32_t i = 0; i < n_tokens; ++i) {
            dspark_token_features tf;
            tf.token = batch_in.token[i];
            tf.position = (uint64_t)batch_in.pos[i];
            tf.features.resize(n_values * sizeof(uint16_t));
            for (size_t v = 0; v < n_values; ++v) {
                float f = features_buf[(size_t)i * n_values + v];
                uint32_t u32;
                std::memcpy(&u32, &f, sizeof(uint32_t));
                uint16_t u16 = (uint16_t)(u32 >> 16); // truncate f32 -> bf16
                std::memcpy(tf.features.data() + v * sizeof(uint16_t), &u16, sizeof(uint16_t));
            }
            feats[tf.position] = std::move(tf);
        }

        return true;
    }

    void draft(common_speculative_draft_params_vec & dparams) override {
        if (!drafter) {
            return;
        }

        // POC is single-sequence: draft for the first sequence that wants one.
        common_speculative_draft_params * dp = nullptr;
        for (llama_seq_id seq_id = 0; seq_id < (llama_seq_id)n_seq; ++seq_id) {
            if (dparams[seq_id].drafting) {
                dp = &dparams[seq_id];
                break;
            }
        }
        if (!dp) {
            return;
        }

        // Committed prefix is positions 0 .. n_past-1. The edge must hold their
        // features before it can draft. The anchor token (id_last) is the token
        // to draft from; its own hidden state is not needed (the draft graph uses
        // its token embedding), so it is sent by id only.
        const int64_t n_past = (int64_t)dp->n_past;

        // Acceptance accounting: since the previous draft, the server committed
        // (n_past - prev_n_past) tokens, of which one is the freshly sampled token
        // and the rest are accepted draft tokens.
        auto & stats = remote_dspark_stats_get();
        if (prev_n_past >= 0) {
            const int64_t accepted = n_past - prev_n_past - 1;
            if (accepted > 0) {
                stats.accepted_tokens += (uint64_t)accepted;
            }
        }
        prev_n_past = n_past;

        auto gather = [&](int64_t lo, int64_t hi, std::vector<dspark_token_features> & out) -> bool {
            for (int64_t pos = lo; pos <= hi; ++pos) {
                auto it = feats.find((uint64_t)pos);
                if (it == feats.end()) {
                    LOG_ERR("%s: missing target features for committed position %lld\n",
                            __func__, (long long)pos);
                    return false;
                }
                out.push_back(it->second);
            }
            return true;
        };

        if (!prefilled) {
            std::vector<dspark_token_features> prefill;
            if (!gather(0, n_past - 1, prefill)) {
                return;
            }
            drafter->prefill(prefill, /*last_chunk*/ true);
            prefilled = true;
            n_sent = n_past - 1;
        }

        remote_dspark_request req;
        req.session_id = 0; // not used by grpc client
        req.step_id    = ++step_id;
        req.position   = (uint64_t)(n_sent < 0 ? 0 : n_sent);
        req.max_draft_tokens = std::min(params.n_max, block_size);
        req.greedy     = true;
        req.anchor_token = dp->id_last;
        if (!gather(n_sent + 1, n_past - 1, req.accepted_tokens)) {
            return;
        }
        n_sent = n_past - 1;

        const auto t_grpc0 = std::chrono::steady_clock::now();
        remote_dspark_response res = drafter->draft(req);
        const auto t_grpc1 = std::chrono::steady_clock::now();
        stats.grpc_us_sum += (uint64_t)std::chrono::duration_cast<std::chrono::microseconds>(t_grpc1 - t_grpc0).count();
        stats.grpc_calls++;

        if (!res.ok) {
            // Edge unreachable or draft failed: record a fallback step and let the
            // server decode this token with the target model only (§16).
            stats.fallback_steps++;
            stats.connected = false;
            LOG_ERR("%s: remote draft failed: %s\n", __func__, res.error.c_str());
            return;
        }

        stats.connected      = true;
        stats.draft_blocks++;
        stats.draft_tokens  += (uint64_t)res.draft_tokens.size();
        stats.edge_draft_us_sum += (uint64_t)res.draft_us;

        for (int32_t tok : res.draft_tokens) {
            dp->result->push_back((llama_token)tok);
        }
    }

    void accept(llama_seq_id /*seq_id*/, uint16_t /*n_accepted*/, bool /*is_other*/) override {
        // noop: acceptance is inferred from dp->n_past on the next draft()
    }

    bool need_embd() const override {
        // The tap-layer hidden states this drafter streams to the edge come from
        // the embeddings_layer_inp capture (extract_layer_inputs), which runs for
        // every ubatch token regardless of per-token output flags. Returning true
        // here would make the server flag every prompt token as an output
        // (slot.need_embd()), overflowing the output buffer the server sizes to
        // n_parallel * (1 + n_draft_max): any prompt chunk longer than that trips
        // GGML_ASSERT(n_outputs_max <= cparams.n_outputs_max) in output_reserve.
        return false;
    }
};
