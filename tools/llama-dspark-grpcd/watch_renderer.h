#pragma once

#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

#include "llama.h"

namespace dspark {

// Live edge preview renderer (--watch).
// Thread-safety: protected by internal mutex; safe to call from gRPC threads.
class watch_renderer {
public:
    explicit watch_renderer(const llama_model * model);

    // Called when prefill or accepted tokens arrive (server-confirmed history).
    void on_accepted(const std::vector<int32_t> & tokens);

    // Called immediately after producing a draft block (pending region).
    void on_draft(const std::vector<int32_t> & tokens);

    // Called with the next DraftRequest's accepted tokens. Matches pending
    // region and restyles confirmed/rejected/replaced tokens.
    void on_verdict(const std::vector<int32_t> & accepted);

    // Called on session reset.
    void on_reset();

    // Force a full redraw of the visible tail.
    void redraw();

private:
    struct region {
        enum state { confirmed, pending, rejected };
        std::string text;
        state st = confirmed;
    };

    std::string detokenize(const std::vector<int32_t> & tokens) const;
    void emit_clear() const;
    void emit_region(const region & r) const;

    const llama_model * model_;
    std::vector<region> transcript_;
    std::vector<int32_t> pending_tokens_;
    std::mutex mtx_;

    static constexpr size_t max_tail_regions = 8;
};

} // namespace dspark
