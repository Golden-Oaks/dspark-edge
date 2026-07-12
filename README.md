# dspark-edging

Remote DSpark speculative decoding over gRPC for llama.cpp.

The server runs the full target LLM and owns the KV cache. The edge device
(Raspberry Pi 5 for the hackathon, any Linux box for development) runs only the
lightweight DSpark draft model. Per-token target hidden states from 5 tap layers
cross the wire; the target KV cache never leaves the server.

## Supported model families

| Family | Draft GGUF arch | Target | Draft |
|--------|-----------------|--------|-------|
| Qwen3-4B | `dflash` | `Qwen3-4B` | `dspark_qwen3_4b_block7` |
| Gemma 4 12B | `dspark` | `gemma-4-12B-it` | `dspark_gemma4_12b_block7` |

The Gemma4 DSpark draft is a distinct `dspark` architecture (Gemma4 backbone:
scaled embeddings, `k_eq_v` attention, attention scale 1.0, post-attention and
post-FFW norms, GELU FFN, proportional RoPE, and final-logit softcapping) with a
fused Markov/confidence head. It is added to the pinned llama.cpp submodule via
`patches/gemma_dspark_llamacpp.patch` (applied by `scripts/apply_gemma_dspark.sh`,
which `scripts/init.sh` runs automatically). The Gemma4 *target* is served by
llama.cpp's existing `gemma4` arch — no target-side changes are needed. Pinned
artifacts and checksums are in `models.lock`.

## Components

- `llama-server` — patched to support `--spec-type draft-remote-dspark`.
- `llama-dspark-grpcd` — edge drafter daemon.
- `llama-spec-watch` — built-in `--watch` terminal preview on the edge device.

## Quick start

```bash
# 1. Initialize and patch llama.cpp
git submodule update --init
./scripts/init.sh

# 2. Build server + daemon (requires gRPC, Protobuf, CMake)
./scripts/build.sh

# 3. Place models (see models/README.md)

# 4. Run the two-process localhost demo
MODELS_DIR=models ./scripts/run_demo.sh
```

## Milestones

| Milestone | Status | Notes |
|-----------|--------|-------|
| 1. Local DSpark on Linux | — | Use upstream `draft-dspark` in pinned llama.cpp branch |
| 2. Daemon skeleton | ✅ | `llama-dspark-grpcd` loads GGUF and serves gRPC API |
| 3. Golden trace dump | — | Instrument local path to dump `.pb` files |
| 4. Daemon replay mode | ✅ | `llama-dspark-grpcd --replay golden/` |
| 5. Fake remote drafter | ✅ | `tests/fake_drafter.py` |
| 6. Real remote drafter | 🔄 | Server patch applies; integration tested at build time |
| 7. Edge preview CLI | ✅ | `--watch` renders pending drafts |
| 8. Demo polish | 🔄 | Debug endpoint stubbed; metrics visible in daemon logs |

## Protocol

Unary gRPC service defined in `proto/dspark.proto`:

- `InitSession` — handshake: target model id, tokenizer hash → tap layers, hidden size, block size, dtype.
- `Prefill` — chunked prompt hidden states to build the draft KV cache.
- `Draft` — accepted tokens + features → draft token block.
- `Reset` — clear session.

## Project layout

```text
.
├── proto/dspark.proto                  # gRPC protocol
├── tools/llama-dspark-grpcd/           # edge daemon
├── server_patches/                     # llama.cpp server patches
│   ├── apply_remote_dspark.py          # patch application script
│   ├── dspark_drafter.h                # drafter abstraction + gRPC client
│   ├── remote_dspark_client.cpp
│   └── remote_dspark_impl.h            # server-side remote impl fragment
├── scripts/                            # init, build, demo
├── tests/                              # proto + fake drafter tests
└── third_party/llama.cpp               # pinned DSpark PR submodule
```

## Notes

- Linux only for this phase. QNX is Phase 2.
- Greedy decoding for the POC; correct non-greedy sampling needs full draft distributions.
- See `handoff.md` for the full specification.
