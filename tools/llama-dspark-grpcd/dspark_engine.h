#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>
#include <mutex>

// llama.cpp public + common headers
#include "llama.h"
#include "common.h"
#include "llama-ext.h"

namespace dspark {

// Per-token feature packet received from the server.
struct token_features {
    int32_t  token;
    uint64_t position;
    std::vector<uint8_t> features; // n_tap_layers * hidden_size * dtype_size bytes
};

// Draft request from the server.
struct draft_request {
    uint64_t session_id;
    uint64_t step_id;
    uint64_t position;                 // truncate draft KV beyond this first
    int32_t  max_draft_tokens;
    bool     greedy;
    int32_t  anchor_token = 0;         // id_last: token the draft block anchors on
    std::vector<token_features> accepted_tokens;
};

// Draft response to the server.
struct draft_response {
    uint64_t session_id;
    uint64_t step_id;
    std::vector<int32_t> draft_tokens;
    std::vector<float>   draft_logprobs;
    std::vector<float>   confidence;
    uint32_t draft_us = 0;
    bool     ok = false;
    std::string error;
};

// Configuration read from the DSpark GGUF.
struct model_config {
    std::string draft_model_id;
    std::vector<int32_t> target_layer_ids;
    int32_t hidden_size = 0;   // target hidden size
    int32_t n_embd_dec = 0;    // draft hidden size
    int32_t block_size = 0;
    std::string feature_dtype = "bf16";
    llama_token mask_token_id = 0;
    float conf_min = 0.0f;     // min predicted acceptance; 0 disables
};

// Engine for one DSpark draft session.
// Thread-safety: one engine per session; the gRPC service serializes calls
// per session via a mutex.
class dspark_engine {
public:
    dspark_engine(llama_model * model, llama_context * ctx);
    ~dspark_engine();

    // Initialize a fresh session. Returns false on error.
    bool init();

    // Metadata exposed during InitSession handshake.
    const model_config & config() const { return cfg_; }

    // Inject prompt token features during prefill.
    bool prefill(const std::vector<token_features> & tokens, uint64_t & n_positions);

    // Truncate stale draft state, inject accepted tokens, and draft a block.
    draft_response draft(const draft_request & req);

    // Reset the session state (clear KV cache, etc.).
    bool reset();

private:
    // Decode a batch of feature vectors into the draft KV cache at the given positions.
    bool inject_features(const std::vector<token_features> & tokens);

    // Run the DSpark anchor-first block and sample draft tokens.
    draft_response run_draft(llama_token anchor, int32_t max_draft_tokens, bool greedy);

    // Convert packed feature bytes (bf16) to float32 for llama_decode.
    std::vector<float> unpack_features(const token_features & tf) const;

    llama_model  * model_ = nullptr;
    llama_context * ctx_  = nullptr;

    model_config cfg_;

    int32_t n_embd_enc_ = 0; // target_layer_ids_n * target_hidden_size

    // Scratch buffer for concatenated float features [n_tokens, n_embd_enc].
    std::vector<float> features_buf_;

    // Batch for injecting encoded features into the draft decoder.
    llama_batch batch_inject_ = {};

    // Batch for the anchor-first noise block.
    llama_batch batch_noise_ = {};

    // Sampler chain (top-k only, like local DFlash/DSpark).
    common_sampler * smpl_ = nullptr;

    // Last drafted block, retained for edge preview verdict matching.
    std::vector<int32_t> last_draft_;
    uint64_t last_step_id_ = 0;

    // Anchor token for the next draft block (last token accepted into KV).
    llama_token last_token_id_ = 0;

    // Highest position of a *confirmed* token injected into the draft KV cache
    // (prompt prefill + accepted tokens). The speculative noise block decoded by
    // run_draft() writes transient KV cells beyond this position; they are removed
    // at the start of the next draft() before new accepted tokens are injected.
    // -1 means the cache is empty. Tracked internally so the daemon never depends
    // on the server's (possibly stale) request position for KV truncation.
    llama_pos kv_confirmed_max_ = -1;
};

// Factory that creates an engine for a new session.
using dspark_engine_factory = std::function<std::unique_ptr<dspark_engine>()>;

using dspark_engine_ptr = std::unique_ptr<dspark_engine>;

} // namespace dspark
