#pragma once

namespace dspark {

class dspark_engine;

// Drive the engine end-to-end with synthetic target features (no server, no target
// model required). Exercises the full DSpark graph: encoder feature fusion, K/V
// injection, the noise-block decoder, the fused Markov/confidence head, and
// sampling. Returns 0 on success, non-zero on failure.
//
// This is a smoke test for the draft-model port (e.g. the Gemma4 "dspark" arch):
// it does not check token *values* (features are random) but verifies that the
// graph builds and runs and that outputs are well-formed and finite.
int run_selftest(dspark_engine & engine);

} // namespace dspark
