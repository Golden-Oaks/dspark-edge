#pragma once

#include <condition_variable>
#include <cstdint>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "llama.h"

namespace dspark {

// Live edge preview renderer (--watch).
//
// The public on_*() methods only enqueue an event and return immediately; all
// terminal drawing happens on a dedicated worker thread. This guarantees the
// gRPC draft path is never blocked by rendering (Milestone 7).
class watch_renderer {
public:
    explicit watch_renderer(const llama_model * model);
    ~watch_renderer();

    // Called when prefill or accepted tokens arrive (server-confirmed history).
    void on_accepted(const std::vector<int32_t> & tokens);

    // Called immediately after producing a draft block (pending region).
    void on_draft(const std::vector<int32_t> & tokens);

    // Called with the next DraftRequest's accepted tokens. Matches pending
    // region and restyles confirmed/rejected/replaced tokens.
    void on_verdict(const std::vector<int32_t> & accepted);

    // Called on session reset.
    void on_reset();

private:
    struct region {
        enum state { confirmed, pending, rejected };
        std::string text;
        state st = confirmed;
    };

    enum class ev_type { accepted, draft, verdict, reset };
    struct event {
        ev_type type;
        std::vector<int32_t> tokens;
    };

    void enqueue(event ev);
    void worker_loop();

    // --- rendering (worker thread only) ---
    void handle_accepted(const std::vector<int32_t> & tokens);
    void handle_draft(const std::vector<int32_t> & tokens);
    void handle_verdict(const std::vector<int32_t> & accepted);
    void handle_reset();
    std::string detokenize(const std::vector<int32_t> & tokens) const;
    void emit_clear() const;
    void emit_region(const region & r) const;
    void redraw() const;

    const llama_model * model_;
    std::vector<region> transcript_;
    std::vector<int32_t> pending_tokens_;

    // --- event queue (producer: gRPC threads, consumer: worker_) ---
    std::mutex mtx_;
    std::condition_variable cv_;
    std::deque<event> queue_;
    bool stop_ = false;
    std::thread worker_;

    static constexpr size_t max_tail_regions = 8;
};

} // namespace dspark
