#include "selftest.h"

#include <cmath>
#include <cstdint>
#include <cstring>
#include <vector>

#include "dspark_engine.h"
#include "log.h"

namespace dspark {

namespace {

// Pack a float as bf16 (truncate the low 16 mantissa bits), matching the
// bf16 feature transport used on the wire.
uint16_t f32_to_bf16(float f) {
    uint32_t u32;
    std::memcpy(&u32, &f, sizeof(u32));
    return (uint16_t)(u32 >> 16);
}

// Build one synthetic feature packet: target_layer_ids_n * hidden_size bf16 values.
//
// The values are intentionally tiny. This is a graph-execution smoke test with no
// real target model, so injected features are out-of-distribution; large synthetic
// hidden states drive the (rms-normed) attention scores to overflow in *both* the
// Gemma "dspark" and Qwen3 "dflash" graphs. Small bounded values keep every op
// finite so we can assert on output shape and finiteness. End-to-end numerical
// parity with real target features is covered separately by golden-trace replay.
token_features make_features(const model_config & cfg, int32_t token, uint64_t position) {
    token_features tf;
    tf.token    = token;
    tf.position = position;

    const size_t n = (size_t)cfg.target_layer_ids.size() * (size_t)cfg.hidden_size;
    tf.features.resize(n * sizeof(uint16_t));

    uint16_t * dst = reinterpret_cast<uint16_t *>(tf.features.data());
    for (size_t i = 0; i < n; ++i) {
        const int32_t phase = (int32_t)((i + position * 7 + (uint64_t)token) % 3) - 1; // -1, 0, +1
        const float   v     = 0.005f * (float)phase;
        dst[i] = f32_to_bf16(v);
    }
    return tf;
}

bool all_finite(const std::vector<float> & xs) {
    for (float x : xs) {
        if (!std::isfinite(x)) {
            return false;
        }
    }
    return true;
}

} // namespace

int run_selftest(dspark_engine & engine) {
    const model_config & cfg = engine.config();

    LOG_INF("[selftest] model=%s hidden_size=%d n_embd_dec=%d block_size=%d target_layers=%zu\n",
            cfg.draft_model_id.c_str(), cfg.hidden_size, cfg.n_embd_dec, cfg.block_size,
            cfg.target_layer_ids.size());

    if (cfg.target_layer_ids.empty() || cfg.hidden_size <= 0 || cfg.block_size <= 0) {
        LOG_ERR("[selftest] invalid model config\n");
        return 1;
    }

    // 1. Prefill a short synthetic prompt.
    const int32_t n_prompt = 8;
    std::vector<token_features> prompt;
    prompt.reserve(n_prompt);
    for (int32_t i = 0; i < n_prompt; ++i) {
        prompt.push_back(make_features(cfg, /*token*/ 100 + i, /*position*/ (uint64_t)i));
    }

    uint64_t n_positions = 0;
    if (!engine.prefill(prompt, n_positions)) {
        LOG_ERR("[selftest] prefill failed\n");
        return 1;
    }
    if (n_positions != (uint64_t)n_prompt) {
        LOG_ERR("[selftest] prefill n_positions=%llu, expected %d\n",
                (unsigned long long)n_positions, n_prompt);
        return 1;
    }

    // 2. Run two draft steps, feeding back the previous block's first token as an
    //    accepted token so the KV-truncation / re-injection path is exercised too.
    llama_token anchor = 100 + n_prompt; // the just-"sampled" token to draft from
    for (int step = 0; step < 2; ++step) {
        draft_request req;
        req.session_id      = 1;
        req.step_id         = (uint64_t)step;
        req.max_draft_tokens = cfg.block_size;
        req.greedy          = true;
        req.anchor_token    = anchor;
        if (step > 0) {
            // pretend the server accepted the anchor from the previous step
            req.accepted_tokens.push_back(make_features(cfg, anchor, (uint64_t)(n_prompt + step - 1)));
        }

        draft_response res = engine.draft(req);
        if (!res.ok) {
            LOG_ERR("[selftest] draft step %d failed: %s\n", step, res.error.c_str());
            return 1;
        }
        if (res.draft_tokens.empty()) {
            LOG_ERR("[selftest] draft step %d produced no tokens\n", step);
            return 1;
        }
        if ((int32_t)res.draft_tokens.size() > cfg.block_size) {
            LOG_ERR("[selftest] draft step %d produced %zu tokens > block_size %d\n",
                    step, res.draft_tokens.size(), cfg.block_size);
            return 1;
        }
        LOG_INF("[selftest] step %d logprobs:", step);
        for (float lp : res.draft_logprobs) { LOG_INF(" %.4f", lp); }
        LOG_INF("\n");
        LOG_INF("[selftest] step %d confidence:", step);
        for (float c : res.confidence) { LOG_INF(" %.4f", c); }
        LOG_INF("\n");
        if (!all_finite(res.draft_logprobs)) {
            LOG_ERR("[selftest] draft step %d has non-finite logprobs\n", step);
            return 1;
        }
        if (!all_finite(res.confidence)) {
            LOG_ERR("[selftest] draft step %d has non-finite confidence\n", step);
            return 1;
        }
        LOG_INF("[selftest] step %d: drafted %zu tokens [", step, res.draft_tokens.size());
        for (size_t i = 0; i < res.draft_tokens.size(); ++i) {
            LOG_INF("%d%s", res.draft_tokens[i], i + 1 < res.draft_tokens.size() ? ", " : "");
        }
        LOG_INF("] (%u us)\n", res.draft_us);

        anchor = res.draft_tokens.front();
    }

    LOG_INF("[selftest] PASS\n");
    return 0;
}

} // namespace dspark
