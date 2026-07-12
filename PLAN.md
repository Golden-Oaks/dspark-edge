# Implementation Plan: Remote DSpark Speculative Decoder

## Status: implemented

This repository now contains the Linux implementation described in `handoff.md`.

## What was delivered

- `llama.cpp` submodule pinned to DSpark PR #25173 (`27cc3bae`).
- gRPC protocol (`proto/dspark.proto`) with `InitSession`, `Prefill`, `Draft`, `Reset`.
- Edge daemon `llama-dspark-grpcd`:
  - Loads a DSpark GGUF.
  - Serves the gRPC protocol.
  - Injects per-token tap-layer features into the local draft KV cache.
  - Runs DSpark anchor-first block drafting.
  - `--watch` live speculation preview renderer.
  - `--replay` golden-trace replay mode.
- Server-side patches (`server_patches/`):
  - `dspark_drafter.h` / `remote_dspark_client.cpp` — gRPC client abstraction.
  - `remote_dspark_impl.h` — server-side remote DSpark speculative impl.
  - `apply_remote_dspark.py` — patches `llama.cpp` in place.
- Build/orchestration scripts (`scripts/init.sh`, `scripts/build.sh`, `scripts/run_demo.sh`).
- Tests: Python proto round-trip tests and fake remote drafter.
- Documentation: `README.md`, `models/README.md`.

## Verified

- `cmake --build build --target llama-dspark-grpcd llama-server` succeeds.
- `llama-server --help` lists `--spec-draft-remote-grpc` and `--spec-type draft-remote-dspark`.
- `llama-dspark-grpcd --help` runs.
- `tests/test_proto.py` passes.

## Milestones (handoff.md §17)

All Phase-1 Linux milestones (1–8) are implemented and verified end-to-end.
See `HANDOFF.md` for status, evidence, and the Milestone-6 root-cause writeup.

- M1 local baseline ✅  M2 daemon skeleton ✅  M3 golden dump ✅  M4 replay (100% parity) ✅
- M5 fake drafter ✅  M6 real remote drafter (acceptance ≈0.31–0.44, greedy-identical) ✅
- M7 `--watch` preview ✅  M8 `/debug/spec` + graceful fallback ✅

## Next steps (not in this phase)

- Phase 2: QNX port of the edge daemon.
- q8 feature transport; temp>0 lossless sampling; multi-sequence batching.
- Live daemon reconnect (server currently handshakes once at startup).
