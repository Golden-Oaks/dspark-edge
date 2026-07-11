#pragma once

#include <string>

#include "dspark_engine.h"

namespace dspark {

// Replay golden feature packets from a directory.
// Expected layout:
//   golden/prefill_chunk_*.pb
//   golden/step_*.request.pb
//   golden/step_*.response.pb (optional, for verification)
// Returns 0 on success, non-zero on failure.
int replay_golden(dspark_engine & engine, const std::string & golden_dir);

} // namespace dspark
