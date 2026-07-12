#include "dspark_engine.h"

#include <algorithm>
#include <cstring>
#include <chrono>

#include "common.h"
#include "log.h"
#include "sampling.h"
#include "llama-ext.h"

namespace dspark {

namespace {

// Convert a packed bf16 buffer to float32.
std::vector<float> bf16_to_f32(const uint8_t * data, size_t n) {
    std::vector<float> out(n);
    for (size_t i = 0; i < n; ++i) {
        uint16_t u16;
        std::memcpy(&u16, data + i * sizeof(uint16_t), sizeof(uint16_t));
        // bf16 -> f32: shift left by 16 bits, reinterpret as float.
        uint32_t u32 = (uint32_t)u16 << 16;
        std::memcpy(&out[i], &u32, sizeof(float));
    }
    return out;
}

} // namespace

dspark_engine::dspark_engine(llama_model * model, llama_context * ctx)
    : model_(model), ctx_(ctx) {
}

dspark_engine::~dspark_engine() {
    llama_batch_free(batch_inject_);
    llama_batch_free(batch_noise_);
    if (smpl_) {
        common_sampler_free(smpl_);
    }
}

bool dspark_engine::init() {
    if (!model_ || !ctx_) {
        return false;
    }

    const size_t target_layer_ids_n = llama_model_target_layer_ids_n(model_);
    cfg_.target_layer_ids.resize(target_layer_ids_n);
    const int32_t * tls = llama_model_target_layer_ids(model_);
    if (tls) {
        std::memcpy(cfg_.target_layer_ids.data(), tls, target_layer_ids_n * sizeof(int32_t));
    }

    cfg_.n_embd_dec  = llama_model_n_embd(model_); // draft decoder hidden size

    // The feature transport hidden size is the *target* model's hidden size.
    // DSpark checkpoints should store this in metadata; fall back to draft n_embd
    // if absent (likely incorrect for true DSpark, but keeps old paths working).
    cfg_.hidden_size = 0;
    {
        char buf[32] = {};
        if (llama_model_meta_val_str(model_, "dflash.target_hidden_size", buf, sizeof(buf)) >= 0 ||
            llama_model_meta_val_str(model_, "target_hidden_size", buf, sizeof(buf)) >= 0) {
            cfg_.hidden_size = std::atoi(buf);
        }
    }
    if (cfg_.hidden_size <= 0) {
        LOG_WRN("[dspark-engine] target hidden size not found in metadata; falling back to draft n_embd\n");
        cfg_.hidden_size = cfg_.n_embd_dec;
    }

    // Read block size from GGUF metadata.
    cfg_.block_size = 16;
    {
        char buf[32] = {};
        if (llama_model_meta_val_str(model_, "dflash.block_size", buf, sizeof(buf)) >= 0) {
            cfg_.block_size = std::atoi(buf);
        }
    }

    cfg_.mask_token_id = llama_vocab_mask(llama_model_get_vocab(model_));
    cfg_.feature_dtype = "bf16";
    cfg_.draft_model_id = "dspark"; // could read from metadata if present

    // Confidence threshold (0 = disabled). Stored as string in metadata if present.
    {
        char buf[32] = {};
        if (llama_model_meta_val_str(model_, "dspark.conf_min", buf, sizeof(buf)) >= 0) {
            cfg_.conf_min = std::stof(buf);
        }
    }

    n_embd_enc_ = (int32_t)cfg_.target_layer_ids.size() * cfg_.hidden_size;

    LOG_INF("[dspark-engine] target_layer_ids_n=%zu hidden_size=%d n_embd_dec=%d block_size=%d\n",
            cfg_.target_layer_ids.size(), cfg_.hidden_size, cfg_.n_embd_dec, cfg_.block_size);

    // Batches.
    const int n_batch = llama_n_batch(ctx_);
    batch_inject_ = llama_batch_init(n_batch, cfg_.n_embd_dec, /*n_seq_max*/ 1);
    batch_noise_  = llama_batch_init(n_batch, 0, /*n_seq_max*/ 1);

    // Sampler: top-k only, matching local DFlash/DSpark defaults.
    common_params_sampling sparams;
    sparams.no_perf  = false;
    sparams.top_k    = 10;
    sparams.samplers = { COMMON_SAMPLER_TYPE_TOP_K };
    smpl_ = common_sampler_init(model_, sparams);

    if (!smpl_ || !batch_inject_.embd || !batch_noise_.token) {
        return false;
    }

    llama_set_embeddings_nextn(ctx_, true, /*masked*/ true);
    llama_set_causal_attn(ctx_, false); // DFlash needs non-causal attention

    return true;
}

std::vector<float> dspark_engine::unpack_features(const token_features & tf) const {
    const size_t expected = (size_t)cfg_.target_layer_ids.size() * (size_t)cfg_.hidden_size * sizeof(uint16_t);
    if (tf.features.size() != expected) {
        LOG_ERR("[dspark-engine] feature size mismatch: got %zu, expected %zu\n",
                tf.features.size(), expected);
        return {};
    }
    return bf16_to_f32(tf.features.data(), (size_t)cfg_.target_layer_ids.size() * (size_t)cfg_.hidden_size);
}

bool dspark_engine::inject_features(const std::vector<token_features> & tokens) {
    if (tokens.empty()) {
        return true;
    }

    const int32_t n_ubatch = llama_n_ubatch(ctx_);
    const int32_t N = (int32_t)tokens.size();

    for (int32_t offset = 0; offset < N; offset += n_ubatch) {
        const int32_t n_chunk = std::min(n_ubatch, N - offset);

        features_buf_.resize((size_t)n_chunk * n_embd_enc_);
        for (int32_t k = 0; k < (int32_t)cfg_.target_layer_ids.size(); ++k) {
            const int32_t layer_id = cfg_.target_layer_ids[k];
            for (int32_t i = 0; i < n_chunk; ++i) {
                const auto & tf = tokens[offset + i];
                std::vector<float> f32 = unpack_features(tf);
                if (f32.empty()) {
                    return false;
                }
                // f32 layout is [target_layer_ids_n, hidden_size]; pick layer k.
                const float * src = f32.data() + (size_t)k * cfg_.hidden_size;
                float * dst = features_buf_.data() + (size_t)i * n_embd_enc_ + (size_t)k * cfg_.hidden_size;
                std::memcpy(dst, src, (size_t)cfg_.hidden_size * sizeof(float));

                // Sanity check: positions must be monotonic within the chunk.
                if (i > 0 && tf.position <= tokens[offset + i - 1].position) {
                    LOG_WRN("[dspark-engine] non-monotonic position %lu after %lu\n",
                            (unsigned long)tf.position, (unsigned long)tokens[offset + i - 1].position);
                }
            }
        }

        // Encode features through DSpark encoder (project-and-inject-K/V graph).
        llama_batch enc_batch = {
            /*.n_tokens =*/ n_chunk,
            /*.token    =*/ nullptr,
            /*.embd     =*/ features_buf_.data(),
            /*.pos      =*/ nullptr,
            /*.n_seq_id =*/ nullptr,
            /*.seq_id   =*/ nullptr,
            /*.logits   =*/ nullptr,
        };

        int32_t rc = llama_encode(ctx_, enc_batch);
        if (rc != 0) {
            LOG_ERR("[dspark-engine] llama_encode failed rc=%d\n", rc);
            return false;
        }

        const float * inp_g = llama_get_embeddings_nextn(ctx_);
        if (!inp_g) {
            LOG_ERR("[dspark-engine] encoder produced no output\n");
            return false;
        }

        batch_inject_.n_tokens = n_chunk;
        std::memcpy(batch_inject_.embd, inp_g, (size_t)n_chunk * cfg_.n_embd_dec * sizeof(float));

        for (int32_t i = 0; i < n_chunk; ++i) {
            batch_inject_.pos[i]       = (llama_pos)tokens[offset + i].position;
            batch_inject_.n_seq_id[i]  = 1;
            batch_inject_.seq_id[i][0] = 0;
            batch_inject_.logits[i]    = false;
        }

        LOG_INF("[dspark-engine] inject_decode: n_tokens=%d pos_first=%d pos_last=%d embd=%p\n",
                (int)n_chunk, (int)batch_inject_.pos[0], (int)batch_inject_.pos[n_chunk - 1],
                (void*)batch_inject_.embd);
        rc = llama_decode(ctx_, batch_inject_);
        if (rc != 0) {
            LOG_ERR("[dspark-engine] llama_decode(inject) failed rc=%d n_tokens=%d pos_first=%d pos_last=%d\n",
                    rc, (int)n_chunk, (int)batch_inject_.pos[0], (int)batch_inject_.pos[n_chunk - 1]);
            return false;
        }
    }

    return true;
}

bool dspark_engine::prefill(const std::vector<token_features> & tokens, uint64_t & n_positions) {
    LOG_INF("[dspark-engine] prefill: n_tokens=%zu pos_first=%ld pos_last=%ld\n",
            tokens.size(),
            tokens.empty() ? -1L : (long)tokens.front().position,
            tokens.empty() ? -1L : (long)tokens.back().position);
    if (!inject_features(tokens)) {
        n_positions = 0;
        return false;
    }
    n_positions = tokens.empty() ? 0 : tokens.back().position + 1;
    if (!tokens.empty()) {
        last_token_id_   = (llama_token)tokens.back().token;
        kv_confirmed_max_ = (llama_pos)tokens.back().position;
    }
    return true;
}

bool dspark_engine::reset() {
    if (!ctx_) {
        return false;
    }
    llama_memory_clear(llama_get_memory(ctx_), /*full*/ true);
    if (smpl_) {
        common_sampler_reset(smpl_);
    }
    last_draft_.clear();
    last_step_id_ = 0;
    last_token_id_ = 0;
    kv_confirmed_max_ = -1;
    return true;
}

draft_response dspark_engine::draft(const draft_request & req) {
    draft_response res;
    res.session_id = req.session_id;
    res.step_id    = req.step_id;

    auto t0 = std::chrono::steady_clock::now();

    // 1. Drop the transient noise block left in the draft KV cache by the previous
    //    draft, keeping only the confirmed prefix [0 .. kv_confirmed_max_]. The KV
    //    max position after this is exactly kv_confirmed_max_, so the accepted
    //    tokens injected next continue consecutively (Y = X + 1).
    //
    //    We deliberately ignore req.position here: accepted-token positions are
    //    authoritative and monotonic, so the daemon's own confirmed high-water mark
    //    is a more reliable truncation point than the server's request position.
    {
        llama_memory_t mem = llama_get_memory(ctx_);
        llama_memory_seq_rm(mem, 0, kv_confirmed_max_ + 1, -1);
    }

    // 2. Inject accepted tokens (may be empty for a correction-only step).
    if (!inject_features(req.accepted_tokens)) {
        res.error = "feature injection failed";
        return res;
    }

    // Advance the confirmed high-water mark.
    if (!req.accepted_tokens.empty()) {
        last_token_id_    = (llama_token)req.accepted_tokens.back().token;
        kv_confirmed_max_ = (llama_pos)req.accepted_tokens.back().position;
    }

    // 3. Run DSpark block draft from the server-supplied anchor (id_last). The
    //    anchor's own hidden state is intentionally not injected; the draft graph
    //    consumes its token embedding at block position 0.
    const llama_token anchor = req.anchor_token != 0 ? (llama_token)req.anchor_token : last_token_id_;
    res = run_draft(anchor, req.max_draft_tokens, req.greedy);

    auto t1 = std::chrono::steady_clock::now();
    res.draft_us = (uint32_t)std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count();
    res.session_id = req.session_id;
    res.step_id    = req.step_id;

    last_draft_   = res.draft_tokens;
    last_step_id_ = req.step_id;

    return res;
}

draft_response dspark_engine::run_draft(llama_token anchor, int32_t max_draft_tokens, bool /*greedy*/) {
    draft_response res;
    res.ok = true;

    common_batch_clear(batch_noise_);

    // DSpark input is [id_last, <mask> * (block_size-1)].
    // The anchor token id is required at position 0; the rest are masks.
    const int32_t n_draft = std::min(max_draft_tokens, cfg_.block_size);
    const llama_pos pos_last = llama_memory_seq_pos_max(llama_get_memory(ctx_), 0);

    for (int32_t i = 0; i < n_draft; ++i) {
        common_batch_add(batch_noise_, i == 0 ? anchor : cfg_.mask_token_id,
                         pos_last + 1 + i, { 0 }, true);
    }

    int ret = llama_decode(ctx_, batch_noise_);
    if (ret != 0) {
        LOG_WRN("[dspark-engine] llama_decode(noise) returned %d\n", ret);
        res.error = "noise decode failed";
        res.ok = false;
        return res;
    }

    common_sampler_reset(smpl_);

    // Optional confidence head.
    const float * conf = cfg_.conf_min > 0.0f ? llama_get_embeddings_nextn(ctx_) : nullptr;

    for (int32_t i = 0; i < n_draft; ++i) {
        if (conf && conf[(size_t)i * cfg_.n_embd_dec] < cfg_.conf_min) {
            break;
        }

        common_sampler_sample(smpl_, ctx_, i, /*apply_grammar*/ false);
        const auto * cur_p = common_sampler_get_candidates(smpl_, /*sort*/ true);
        if (!cur_p || cur_p->size == 0) {
            break;
        }

        const llama_token id = cur_p->data[0].id;
        res.draft_tokens.push_back(id);
        res.draft_logprobs.push_back(cur_p->data[0].logit);
        if (conf) {
            res.confidence.push_back(conf[(size_t)i * cfg_.n_embd_dec]);
        }

        common_sampler_accept(smpl_, id, /*apply_grammar*/ false);
    }

    return res;
}

} // namespace dspark
