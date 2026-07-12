#pragma once

// Process-global metrics for the remote DSpark speculative path.
// Written by common_speculative_impl_draft_remote_dspark, read by the
// llama-server GET /debug/spec endpoint (Milestone 8).

#include <atomic>
#include <cstdint>
#include <string>

struct remote_dspark_stats {
    std::atomic<bool>     connected{false};      // edge daemon reachable
    std::atomic<uint64_t> draft_blocks{0};       // successful remote draft() calls
    std::atomic<uint64_t> draft_tokens{0};       // total tokens proposed by the edge
    std::atomic<uint64_t> accepted_tokens{0};    // draft tokens the target accepted
    std::atomic<uint64_t> fallback_steps{0};     // remote draft calls that failed
    std::atomic<uint64_t> edge_draft_us_sum{0};  // sum of edge-reported draft latency (us)
    std::atomic<uint64_t> grpc_us_sum{0};        // sum of client-side round-trip (us)
    std::atomic<uint64_t> grpc_calls{0};         // number of round-trips measured
    std::string           edge_host;             // set once at session init
};

// Meyers singleton — safe regardless of static init order across TUs.
remote_dspark_stats & remote_dspark_stats_get();
