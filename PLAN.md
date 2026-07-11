# Implementation Plan: Remote DSpark Speculative Decoder

## Objective
Implement the system described in `handoff.md`:
1. Patched `llama-server` with `draft-remote-dspark` speculative mode.
2. Edge drafter daemon `llama-dspark-grpcd`.
3. Edge preview CLI (`--watch`).
4. gRPC protocol, build scripts, and tests.

## Repository Layout

```
.
├── handoff.md              # Source spec
├── PLAN.md                 # This file
├── README.md               # User-facing overview
├── .gitignore
├── .gitmodules             # llama.cpp submodule
├── CMakeLists.txt          # Top-level orchestration
├── proto/
│   └── dspark.proto        # gRPC service definition
├── third_party/
│   └── llama.cpp/          # git submodule (pinned)
├── patches/
│   ├── 0001-dspark-pr.patch # DSpark PR #25173 diff (placeholder)
│   └── 0002-remote-dspark.patch # Our server-side patch
├── tools/
│   └── llama-dspark-grpcd/ # Edge daemon
│       ├── CMakeLists.txt
│       ├── main.cpp
│       ├── grpc_service.cpp
│       ├── grpc_service.h
│       ├── dspark_engine.cpp
│       ├── dspark_engine.h
│       ├── watch_renderer.cpp
│       ├── watch_renderer.h
│       └── replay_mode.cpp
├── server_patches/
│   ├── remote_dspark_client.h
│   ├── remote_dspark_client.cpp
│   └── server_integration.cpp
├── scripts/
│   ├── init.sh             # Clone submodule + apply patches
│   ├── build.sh            # Build server + daemon
│   └── run_demo.sh         # Localhost two-process demo
├── tests/
│   ├── test_proto.py
│   ├── test_daemon_replay.py
│   └── fake_drafter.cpp
└── models/
    └── README.md           # Where to place GGUFs
```

## Work Items

- [ ] Add `llama.cpp` submodule pinned to a known DSpark-compatible commit.
- [ ] Create gRPC protocol (`proto/dspark.proto`).
- [ ] Implement edge daemon core:
  - [ ] GGUF loading / metadata handshake.
  - [ ] Prefill feature injection.
  - [ ] Draft block generation using lifted DSpark logic.
  - [ ] Reset and session management.
  - [ ] Replay mode for golden traces.
- [ ] Implement edge preview renderer (`--watch`).
- [ ] Implement server-side `draft-remote-dspark` integration:
  - [ ] gRPC client wrapper.
  - [ ] Speculative backend registration.
  - [ ] Feature extraction / packing.
  - [ ] Fallback path on edge failure.
- [ ] Provide fake remote drafter for Milestone 5.
- [ ] Build scripts and CMake orchestration.
- [ ] Add unit/smoke tests.
- [ ] Update README with usage.

## Constraints
- Linux only for this phase (QNX deferred).
- Server KV cache never leaves the server.
- Edge device only receives tap-layer hidden states.
- Greedy decoding for the POC; non-greedy deferred.
