#include "replay_mode.h"

#include <algorithm>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <regex>
#include <vector>

#include "common.h"
#include "dspark.pb.h"
#include "log.h"

namespace dspark {

namespace fs = std::filesystem;

static bool read_file(const fs::path & path, std::string & out) {
    std::ifstream f(path, std::ios::binary);
    if (!f) return false;
    out.assign((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    return true;
}

int replay_golden(dspark_engine & engine, const std::string & golden_dir) {
    fs::path dir(golden_dir);
    if (!fs::is_directory(dir)) {
        LOG_ERR("[replay] not a directory: %s\n", golden_dir.c_str());
        return 1;
    }

    std::vector<fs::path> prefill_files;
    std::vector<fs::path> request_files;

    for (const auto & entry : fs::directory_iterator(dir)) {
        const std::string name = entry.path().filename().string();
        if (name.find("prefill_chunk_") == 0 && name.size() > 3 && name.compare(name.size() - 3, 3, ".pb") == 0) {
            prefill_files.push_back(entry.path());
        } else if (std::regex_match(name, std::regex("step_\\d+_request\\.pb"))) {
            request_files.push_back(entry.path());
        }
    }

    std::sort(prefill_files.begin(), prefill_files.end());
    std::sort(request_files.begin(), request_files.end());

    // Replay prefill chunks.
    for (const auto & path : prefill_files) {
        std::string buf;
        if (!read_file(path, buf)) {
            LOG_ERR("[replay] failed to read %s\n", path.c_str());
            return 1;
        }
        PrefillRequest req;
        if (!req.ParseFromString(buf)) {
            LOG_ERR("[replay] failed to parse %s\n", path.c_str());
            return 1;
        }
        std::vector<token_features> tokens;
        tokens.reserve(req.tokens_size());
        for (const auto & pt : req.tokens()) {
            token_features tf;
            tf.token = pt.token();
            tf.position = pt.position();
            tf.features.assign(pt.features().begin(), pt.features().end());
            tokens.push_back(std::move(tf));
        }
        uint64_t n_positions = 0;
        if (!engine.prefill(tokens, n_positions)) {
            LOG_ERR("[replay] prefill failed for %s\n", path.c_str());
            return 1;
        }
        LOG_INF("[replay] %s -> n_positions=%lu\n", path.filename().c_str(), (unsigned long)n_positions);
    }

    // Replay draft requests.
    int step = 0;
    for (const auto & path : request_files) {
        std::string buf;
        if (!read_file(path, buf)) {
            LOG_ERR("[replay] failed to read %s\n", path.c_str());
            return 1;
        }
        DraftRequest req;
        if (!req.ParseFromString(buf)) {
            LOG_ERR("[replay] failed to parse %s\n", path.c_str());
            return 1;
        }
        draft_request dreq;
        dreq.session_id = req.session_id();
        dreq.step_id    = req.step_id();
        dreq.position   = req.position();
        dreq.max_draft_tokens = req.max_draft_tokens();
        dreq.greedy     = req.greedy();
        for (const auto & pt : req.accepted_tokens()) {
            token_features tf;
            tf.token = pt.token();
            tf.position = pt.position();
            tf.features.assign(pt.features().begin(), pt.features().end());
            dreq.accepted_tokens.push_back(std::move(tf));
        }

        auto res = engine.draft(dreq);
        LOG_INF("[replay] %s -> draft_tokens=%zu draft_us=%u\n",
                path.filename().c_str(), res.draft_tokens.size(), res.draft_us);
        ++step;
    }

    LOG_INF("[replay] completed %d draft steps\n", step);
    return 0;
}

} // namespace dspark
