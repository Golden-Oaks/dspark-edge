#include "watch_renderer.h"

#include <algorithm>
#include <cstdio>
#include <cstring>

#include "common.h"
#include "log.h"

namespace dspark {

watch_renderer::watch_renderer(const llama_model * model) : model_(model) {
    worker_ = std::thread(&watch_renderer::worker_loop, this);
}

watch_renderer::~watch_renderer() {
    {
        std::lock_guard<std::mutex> lock(mtx_);
        stop_ = true;
    }
    cv_.notify_all();
    if (worker_.joinable()) {
        worker_.join();
    }
}

void watch_renderer::enqueue(event ev) {
    {
        std::lock_guard<std::mutex> lock(mtx_);
        queue_.push_back(std::move(ev));
    }
    cv_.notify_one();
}

void watch_renderer::on_accepted(const std::vector<int32_t> & tokens) {
    if (tokens.empty()) return;
    enqueue({ev_type::accepted, tokens});
}

void watch_renderer::on_draft(const std::vector<int32_t> & tokens) {
    enqueue({ev_type::draft, tokens});
}

void watch_renderer::on_verdict(const std::vector<int32_t> & accepted) {
    enqueue({ev_type::verdict, accepted});
}

void watch_renderer::on_reset() {
    enqueue({ev_type::reset, {}});
}

void watch_renderer::worker_loop() {
    for (;;) {
        event ev;
        {
            std::unique_lock<std::mutex> lock(mtx_);
            cv_.wait(lock, [&] { return stop_ || !queue_.empty(); });
            if (stop_ && queue_.empty()) {
                return;
            }
            ev = std::move(queue_.front());
            queue_.pop_front();
        }
        switch (ev.type) {
            case ev_type::accepted: handle_accepted(ev.tokens); break;
            case ev_type::draft:    handle_draft(ev.tokens);    break;
            case ev_type::verdict:  handle_verdict(ev.tokens);  break;
            case ev_type::reset:    handle_reset();             break;
        }
    }
}

std::string watch_renderer::detokenize(const std::vector<int32_t> & tokens) const {
    std::string out;
    const llama_vocab * vocab = llama_model_get_vocab(model_);
    for (int32_t tok : tokens) {
        out += common_token_to_piece(vocab, (llama_token)tok);
    }
    return out;
}

void watch_renderer::emit_clear() const {
    // ANSI clear current line and move cursor to start.
    std::fprintf(stderr, "\r\x1b[K");
}

void watch_renderer::emit_region(const region & r) const {
    switch (r.st) {
        case region::pending:
            std::fprintf(stderr, "\x1b[3m\x1b[90m%s\x1b[0m", r.text.c_str()); // italic gray
            break;
        case region::rejected:
            std::fprintf(stderr, "\x1b[9m\x1b[31m%s\x1b[0m", r.text.c_str()); // strikethrough red
            break;
        case region::confirmed:
        default:
            std::fprintf(stderr, "%s", r.text.c_str());
            break;
    }
}

void watch_renderer::handle_accepted(const std::vector<int32_t> & tokens) {
    if (tokens.empty()) return;
    region r;
    r.text = detokenize(tokens);
    r.st   = region::confirmed;
    transcript_.push_back(std::move(r));
    redraw();
}

void watch_renderer::handle_draft(const std::vector<int32_t> & tokens) {
    if (tokens.empty()) return;
    pending_tokens_ = tokens;
    region r;
    r.text = detokenize(tokens);
    r.st   = region::pending;
    transcript_.push_back(std::move(r));
    redraw();
}

void watch_renderer::handle_verdict(const std::vector<int32_t> & accepted) {
    if (pending_tokens_.empty()) {
        // No pending region; just append accepted tokens as confirmed.
        if (!accepted.empty()) {
            region r;
            r.text = detokenize(accepted);
            r.st   = region::confirmed;
            transcript_.push_back(std::move(r));
            redraw();
        }
        return;
    }

    // Remove the pending region(s) from the tail; we'll rebuild them.
    while (!transcript_.empty() && transcript_.back().st == region::pending) {
        transcript_.pop_back();
    }

    // Find longest matching prefix between pending_tokens_ and accepted.
    size_t match = 0;
    const size_t n = std::min(pending_tokens_.size(), accepted.size());
    while (match < n && pending_tokens_[match] == accepted[match]) {
        ++match;
    }

    // Confirmed prefix -> normal text.
    if (match > 0) {
        std::vector<int32_t> confirmed(pending_tokens_.begin(), pending_tokens_.begin() + match);
        region r;
        r.text = detokenize(confirmed);
        r.st   = region::confirmed;
        transcript_.push_back(std::move(r));
    }

    // First rejected token -> strikethrough flash.
    if (match < pending_tokens_.size()) {
        std::vector<int32_t> rejected(1, pending_tokens_[match]);
        region r;
        r.text = detokenize(rejected);
        r.st   = region::rejected;
        transcript_.push_back(std::move(r));
    }

    // Server correction / remaining accepted tokens -> normal text.
    if (match < accepted.size()) {
        std::vector<int32_t> corr(accepted.begin() + match, accepted.end());
        region r;
        r.text = detokenize(corr);
        r.st   = region::confirmed;
        transcript_.push_back(std::move(r));
    }

    pending_tokens_.clear();
    redraw();
}

void watch_renderer::handle_reset() {
    pending_tokens_.clear();
    transcript_.clear();
    // Print a newline to seal off the finished transcript before the next one.
    std::fprintf(stderr, "\n");
    std::fflush(stderr);
}

void watch_renderer::redraw() const {
    emit_clear();
    const size_t start = transcript_.size() > max_tail_regions
                             ? transcript_.size() - max_tail_regions
                             : 0;
    for (size_t i = start; i < transcript_.size(); ++i) {
        emit_region(transcript_[i]);
    }
    std::fflush(stderr);
}

} // namespace dspark
