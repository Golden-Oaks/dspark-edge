# Handoff: Remote DSpark Speculative Decoder — Milestones Complete

## Current Status (as of 2026-07-11)

All Phase-1 (Linux) milestones from `handoff.md` §17 are **implemented and verified
end-to-end**. Remote DSpark speculative decoding runs over gRPC with the target
model + KV cache on the server and the DSpark drafter on the edge daemon; the
server produces greedy-identical output while accepting real draft blocks from
the edge.

Pinned to llama.cpp DSpark PR #25173 (commit `27cc3bae`).

## Milestone status

| # | Milestone | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Local DSpark baseline | ✅ | `llama-cli --spec-type draft-dspark` → `1 + 1 = 2.` |
| 2 | Daemon skeleton | ✅ | `llama-dspark-grpcd` loads GGUF, serves gRPC, `InitSession` from metadata |
| 3 | Golden trace dump | ✅ | `LLAMA_DSPARK_GOLDEN_DIR` → `golden/` (1 prefill + 20 request/response `.pb`) |
| 4 | Daemon replay mode | ✅ | `--replay golden/` → **20/20 steps EXACT, 140/140 token parity (100%)** |
| 5 | Fake remote drafter | ✅ | `tests/fake_drafter.py`; server verifies/rejects fake drafts |
| 6 | Real remote drafter | ✅ | End-to-end greedy-identical output; **draft acceptance ≈ 0.31–0.44** |
| 7 | Edge preview CLI | ✅ | `--watch`: gray/italic pending, strikethrough rejects, async (non-blocking) |
| 8 | Debug/metrics + fallback | ✅ | `GET /debug/spec`; server survives daemon crash, `fallback_steps` counts |

## The blocker that was fixed (Milestone 6)

The remote path failed with `feature injection failed` on every draft. Root
cause was **not** feature format — it was draft-KV-cache position desync, driven
by three server-side bugs in `remote_dspark_impl.h`:

1. **Empty prefill.** `common_speculative_process(prompt)` runs *before*
   `common_speculative_begin`, and `begin()` cleared the prefill buffer — wiping
   the prompt features `process()` had just captured. The draft model then had no
   context (0 acceptance), and accepted-token positions could never line up with
   an empty draft KV.
2. **Overlapping accepted tokens.** `process()` re-buffered the entire verify
   batch (`[anchor, draft_0..draft_n]`) as "accepted" every step, so successive
   `Draft` calls injected overlapping positions (e.g. 5–12 then 6–13).
3. **Wrong anchor.** The DSpark block must anchor on `id_last` (the just-sampled
   token, whose hidden state is not yet available), which was never transmitted.

**Fix:** the server impl now keys captured features by sequence position
(`std::map<pos, features>`), drives everything off `dp->n_past` / `dp->id_last`,
ships only positions `n_sent+1 .. n_past-1` per step, and sends the anchor token
explicitly via a new `DraftRequest.anchor_token` proto field. The daemon
self-tracks its confirmed KV high-water mark (`kv_confirmed_max_`) and truncates
the previous noise block itself, never trusting the request position.

## What works (verified this session)

- **Correctness:** remote spec output is byte-identical to the no-speculation
  baseline (e.g. `Q: What is 2+2? A:` → `' 4. But wait, what if I say 2+2=5? ...'`).
- **Acceptance:** 0.31 on `"The capital of France is"`, 0.44 on a counting prompt.
- **Golden/replay:** deterministic 100% token parity.
- **Watch preview:** confirmed plain / pending italic-gray / rejected red-strike,
  rendered on a dedicated worker thread (draft path never blocks).
- **Metrics:** `/debug/spec` reports connected state, draft blocks/tokens,
  accepted tokens, acceptance rate, avg edge-draft ms, avg gRPC ms, fallback count.
- **Fallback:** killing the daemon mid-serving does not crash the server; it
  finishes with target-only decoding and flips `/debug/spec` to `disconnected`.

## Key commands

```bash
# Build
./scripts/build.sh          # or: cmake --build build --target llama-dspark-grpcd llama-server -j

# 1. Edge daemon (start first). Add --watch for the live preview, or
#    --replay golden/ to replay a golden trace with no server.
./build/tools/llama-dspark-grpcd/llama-dspark-grpcd \
  --model models/dspark_qwen3_4b_block7.gguf \
  --target-model models/Qwen3-4B-Q8_0.gguf \
  --host 127.0.0.1 --port 50051 --threads 4

# 2. Patched server. Set LLAMA_DSPARK_GOLDEN_DIR=$PWD/golden to dump a trace.
./build/bin/llama-server -m models/Qwen3-4B-Q8_0.gguf \
  --host 127.0.0.1 --port 8080 \
  --spec-type draft-remote-dspark \
  --spec-draft-remote-grpc 127.0.0.1:50051 \
  --spec-draft-n-max 7 -t 8 --ctx-size 1024 --reasoning off

# 3. Generate + inspect metrics
curl -s -X POST http://127.0.0.1:8080/completion -H "Content-Type: application/json" \
  -d '{"prompt":"The capital of France is","n_predict":20,"temperature":0,"top_k":1}'
curl -s http://127.0.0.1:8080/debug/spec | python3 -m json.tool
```

## Protocol change

`DraftRequest` gained `int32 anchor_token = 7` — the `id_last` the DSpark block
anchors on, carried by id only (its target hidden state is not yet available).
Server (`remote_dspark_client.cpp`), daemon (`grpc_service.cpp` / `dspark_engine`),
and replay all read it. Re-run `server_patches/apply_remote_dspark.py` after any
edit to `proto/dspark.proto` or the `server_patches/*` files, then rebuild.

## Files of interest

- `server_patches/remote_dspark_impl.h` — server-side impl (position-keyed features, prefill/accepted split, anchor, /debug/spec stats)
- `server_patches/remote_dspark_client.cpp` — gRPC client + golden-trace dump + stats accessor
- `server_patches/dspark_stats.h` — process-global metrics surfaced by `/debug/spec`
- `tools/llama-dspark-grpcd/dspark_engine.cpp` — daemon engine (self-tracked KV truncation, anchor injection)
- `tools/llama-dspark-grpcd/watch_renderer.cpp` — async `--watch` preview
- `tools/llama-dspark-grpcd/replay_mode.cpp` — `--replay` with golden-response comparison
- `server_patches/apply_remote_dspark.py` — applies all patches (incl. `/debug/spec` route)

## Not done (out of scope — Phase 2)

- QNX port of the edge daemon (`handoff.md` §20).
- q8 feature transport, temp>0 lossless sampling, multi-sequence batching (§21).
- Live daemon reconnect: the server handshakes once at startup; after a daemon
  crash it stays in fallback until restarted (matches §16, which does not require
  reconnection).
