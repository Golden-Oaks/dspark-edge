# Implementation Handoff: Remote DSpark Speculative Decoder over gRPC (llama.cpp)

## 0. Scope & Context — read this first

**Current phase (this handoff):** build the three components on **Linux**:

1. **Server** — patched `llama-server` with a `draft-remote-dspark` speculative mode.
2. **Edge drafter daemon** — `llama-dspark-grpcd`, runs the DSpark draft model, deployed on a Raspberry Pi 5 (8 GB, Linux). Develop against localhost first; the Pi is just a second Linux box.
3. **Edge preview CLI** — the `--watch` terminal view on the Pi that shows speculated tokens before the server's verified stream (§15).

**Explicitly out of scope for now:** the QNX port. It comes later, as Phase 2 (§20), once the client/server/CLI work end-to-end on Linux. While building, keep the daemon portable (no Linux-only APIs where a portable one is cheap) so Phase 2 is a recompile, not a rewrite.

**Context links:**

| What | Where |
|---|---|
| Target model | https://huggingface.co/Qwen/Qwen3-4B |
| Draft checkpoint | https://huggingface.co/deepseek-ai/dspark_qwen3_4b_block7 |
| DSpark llama.cpp PR | https://github.com/ggml-org/llama.cpp/pull/25173 (open, force-pushed — **pin the commit you fork from**) |
| QNX port (Phase 2 only) | https://github.com/xtang2010/llama.cpp-qnx |

Suggested order of work: Milestones in §17, leaning hard on the steal list in §4.

---

## 1. Vision

Build a hackathon-ready distributed speculative decoding system where:

- The **server** runs the full target LLM using a fork of `llama.cpp`.
- The **edge device** (Raspberry Pi 5, 8 GB) runs only the lightweight **DSpark draft model**.
- The server communicates with the edge drafter over **gRPC**.
- The target model’s **KV cache never leaves the server**.
- The edge device receives per-token target hidden states (from the checkpoint's 5 tap layers), builds its own local draft KV cache from them, and returns draft token suggestions.
- The server verifies all drafts using the full model and streams final output through a webserver.
- The edge device's own terminal shows the speculation live, ahead of the server's stream (§15).

The core pitch:

> The server owns correctness, KV cache, sampling, and final text. The edge device acts as a DSpark speculative draft appliance that proposes token blocks over gRPC — and you can watch it guess the future on its own screen.

Why DSpark and not MTP: both split at the hidden-state boundary in principle, but no standalone edge-sized MTP checkpoint exists for Qwen3 and llama.cpp has no MTP drafting path. DSpark has a matched Pi-sized checkpoint (`deepseek-ai/dspark_qwen3_4b_block7`, 1.39B) and a llama.cpp implementation (PR #25173), and its one-pass block drafting suits a CPU drafter. Either way, only hidden states cross the network (~25.6 KB/token) — the target KV cache (~144 KB/token) never leaves the server.

---

## 2. Target Architecture

```text
Browser / client
   ↓ HTTP, SSE, or WebSocket

Server webserver
   ↓ localhost HTTP/SSE

Patched llama.cpp server
   - full target model
   - tokenizer
   - sampler
   - authoritative KV cache
   - speculative verification
   - hidden/feature extraction
   ↓ gRPC over LAN

Edge DSpark daemon  (Raspberry Pi 5 — Linux now, QNX in Phase 2)
   - DSpark GGUF model
   - CPU-only llama.cpp runtime
   - receives per-token target hidden states (5 tap layers)
   - maintains its own local draft KV cache
   - returns draft token block + confidence
   - renders the live edge preview (--watch)
```

The edge device should not be exposed directly to users.

---

## 3. Major Design Rule

Do **not** make the edge device a remote llama.cpp backend.

Make it a **remote DSpark drafter**.

Bad design:

```text
Server sends KV cache / tensor backend work to the edge.
Edge participates in full target inference.
```

Good design:

```text
Server streams per-token target hidden states to the edge.
Edge builds its own draft KV cache and returns draft token IDs.
Server verifies with full target model.
```

The server remains the source of truth.

---

## 4. Repositories / Fork Strategy

Expected upstreams:

- `ggml-org/llama.cpp`
- llama.cpp DSpark PR #25173 (open `draft-dspark` work — pin the exact commit; the branch is force-pushed during review, and the steal list below references its current state)

Recommended branches:

```text
dspark-upstream-sync
  Clean sync of llama.cpp + DSpark PR, pinned.

remote-dspark-grpc
  New remote DSpark speculative backend + edge daemon + preview CLI.
```

(Phase 2 adds a `qnx-dspark-build` branch for QNX build fixes only — see §20.)

### Steal list: PR #25173

Deliberately lift implementation details from the DSpark PR rather than
writing anything fresh. The key realization: the PR's drafter class already
factors at exactly the seam we need to cut. `common_speculative_impl_draft_dflash`
(in `common/speculative.cpp`, ~line 915; DSpark is the same class with
`is_dspark = true`) has two halves:

```text
process()  — extracts target features and injects them into the draft KV cache
draft()    — runs the anchor-first noise block and samples draft tokens
```

The remote split cuts between them: the **server** keeps the extraction half
of `process()`, the **edge daemon** gets the injection half plus all of
`draft()`. Neither half needs new inference logic.

**For the edge daemon — lift nearly verbatim:**

- The class's per-session state is exactly the daemon's session state:
  `block_size`, `mask_token_id` (via `llama_vocab_mask`), `target_layer_ids`,
  and `features_buf` (scratch for concatenated features `[n_tokens, n_embd_enc]`).
- The `Prefill` / accepted-token handler is `process()`'s injection path:
  fill `features_buf` (from the network instead of the local target ctx),
  build an embd batch, `llama_decode` it into the draft context. The
  dual-mode decoder graph in `src/models/dflash.cpp` does the
  project-and-inject-K/V automatically for embd batches — reuse untouched.
- The `Draft` handler is `draft()`: anchor-first block
  `[id_last, <mask> × (n-1)]` (DSpark samples all `block_size` positions;
  `n_block_tokens = n_draft`, unlike DFlash's `n_draft + 1`). Copy the
  `is_dspark` sampling loop wholesale, including the confidence early-break
  that reads per-position confidence from `llama_get_embeddings_nextn(ctx_dft)`
  when `conf_min > 0`.
- Build the daemon inside the llama.cpp fork (a new tool under `tools/`) so
  it links the same `common/` and model code — the draft graph needs
  `src/models/dflash.cpp` plus the arch plumbing (`src/llama-arch.{h,cpp}`,
  `src/llama-model.h`) and the GGUF constants (`gguf-py/gguf/constants.py`,
  `tensor_mapping.py`).

**For the server (`draft-remote-dspark`) — copy the registration pattern:**

The PR is a precise checklist of every touch point for adding a speculative
type; register `draft-remote-dspark` the same way DSpark itself was added:

```text
common/common.h        enum entry + need_n_rs_seq()
common/speculative.cpp type<->string maps (both directions),
                       common_speculative_n_max switch,
                       common_speculative_init config + impl switch,
                       static_assert(COMMON_SPECULATIVE_TYPE_COUNT == ...) bump
common/arg.cpp         flag pattern (--spec-draft-remote-grpc copies the
                       shape of --spec-draft-conf-min, incl. env var)
tools/server/server-schema.cpp   schema entry
```

Feature extraction on the server reuses the exact same
`llama_get_embeddings_nextn(ctx_tgt)` + `features_buf` concatenation that
local `process()` uses — the remote impl packs that buffer into
`TokenFeatures` messages instead of decoding it into a local draft context.
One substitution: the local impl reads `target_layer_ids` from the loaded
draft model; the remote impl takes them from the `InitSession` handshake.

**For conversion:** `conversion/qwen.py` (`Qwen3DSparkModel`) plus the
gguf-py mappings. Note the graph hard-asserts the GGUF metadata key
`dflash.block_size` and the tensors `markov_w1.weight` / `markov_w2.weight`
(+ optional `dspark_conf_proj`) — the Milestone 2 load check should verify
these by name.

---

## 5. Initial Model Target

Use a Qwen3 DSpark model first.

Recommended hackathon target:

```text
Target model on server:
  Qwen/Qwen3-4B GGUF (36 layers, hidden_size 2560)

Draft model on the edge:
  deepseek-ai/dspark_qwen3_4b_block7
  (1.39B params, 5 draft layers, block size 7,
   taps target hidden states at layers [1, 9, 17, 25, 33])
```

DSpark checkpoints are target-specific (the conversion inherits the target's
tokenizer and embeddings via `--target-model-dir`), so the target must be
exactly Qwen3-4B — do not mix with 8B.

Avoid starting with Gemma 4 unless the DSpark path for it is already stable in the chosen llama.cpp branch.

Block size should initially be:

```text
max_draft_tokens = 7
```

because current DSpark checkpoints are block-7 style.

---

## 6. Required Binaries

### Server

Add or modify `llama-server` to support:

```text
--spec-type draft-remote-dspark
```

Example final command:

```bash
./llama-server \
  -m models/Qwen3-4B-Q4_K_M.gguf \
  --host 127.0.0.1 \
  --port 8080 \
  --ctx-size 4096 \
  --n-gpu-layers 99 \
  --flash-attn on \
  --parallel 1 \
  --spec-type draft-remote-dspark \
  --spec-draft-remote-grpc pi-edge.local:50051 \
  --spec-draft-n-max 7 \
  --temp 0 \
  --top-k 1
```

(During development, `--spec-draft-remote-grpc 127.0.0.1:50051` with the
daemon on the same machine — the Pi is not required until Milestone 6.)

### Edge drafter daemon

Add a new small daemon:

```text
llama-dspark-grpcd
```

Responsibilities:

- Load DSpark GGUF.
- Start gRPC server.
- Answer `InitSession` with the checkpoint's requirements (tap layer IDs, hidden size, block size, dtype).
- Receive `Prefill` chunks and build the local draft KV cache over the prompt.
- Receive `DraftRequest`, inject accepted-token hidden states into the draft KV cache, truncate stale positions.
- Run DSpark block draft step.
- Return token IDs, confidence, and timing metadata.
- (`--watch`) render the live edge preview (§15).

Example command:

```bash
./llama-dspark-grpcd \
  --model models/dspark_qwen3_4b_block7.gguf \
  --host 0.0.0.0 \
  --port 50051 \
  --threads 4 \
  --watch
```

---

## 7. What Should Cross gRPC

Do send:

```text
once per session (server → edge):
  target model id, tokenizer hash

once per session (edge → server):
  tap layer ids, hidden size, block size, feature dtype
  (the server never loads the draft GGUF — this handshake is how it
   learns which layers to extract)

after target prefill (server → edge, chunked):
  hidden states for every prompt token (all tap layers)

every decode step (server → edge):
  session_id, step_id, position
  tokens accepted since the last step, each with:
    token id, position, hidden states from all tap layers
  max draft length
```

Do not send:

```text
target KV cache
full target model state
full prompt every step
server-side llama.cpp context
target logits history
sampling authority
```

The edge only proposes tokens. The server decides what is accepted.

---

## 8. gRPC Protocol

Start with unary RPCs. Streaming can be added after the MVP works.

Commit is folded into `Draft`: each `Draft` call carries the tokens accepted
by the previous verification, with their hidden states. That keeps one RPC
per decode step and makes the drafter's KV-cache sync implicit — the drafter
injects the new features, discards any local state past `position` (rejected
drafts), then drafts the next block.

```proto
syntax = "proto3";

package dspark;

service DSparkDraftService {
  rpc InitSession(InitSessionRequest) returns (InitSessionResponse);
  rpc Prefill(PrefillRequest) returns (PrefillResponse);
  rpc Draft(DraftRequest) returns (DraftResponse);
  rpc Reset(ResetRequest) returns (ResetResponse);
}

message InitSessionRequest {
  string target_model_id = 1;
  string tokenizer_hash = 2;
}

// The drafter tells the server what it needs. The server configures its
// hidden-state extraction from this — it never loads the draft GGUF.
message InitSessionResponse {
  uint64 session_id = 1;
  bool ok = 2;
  string message = 3;

  string draft_model_id = 4;
  repeated uint32 target_layer_ids = 5; // [1, 9, 17, 25, 33] for this checkpoint
  uint32 hidden_size = 6;               // 2560
  uint32 block_size = 7;                // 7
  string feature_dtype = 8;             // bf16
}

// One entry per token. `features` layout: hidden states concatenated in
// target_layer_ids order, hidden_size values each, packed as feature_dtype.
// For this checkpoint: 5 * 2560 * 2 bytes = 25,600 bytes per token.
message TokenFeatures {
  int32 token = 1;
  uint64 position = 2;
  bytes features = 3;
}

// Sent in chunks after the server finishes target prefill, before the
// first Draft call.
message PrefillRequest {
  uint64 session_id = 1;
  repeated TokenFeatures tokens = 2;
  bool last_chunk = 3;
}

message PrefillResponse {
  bool ok = 1;
  uint64 n_positions = 2; // drafter KV fill level, for sanity checks
}

// One call per decode step.
message DraftRequest {
  uint64 session_id = 1;
  uint64 step_id = 2;

  // Tokens accepted since the previous step (1 .. block_size + 1 entries).
  repeated TokenFeatures accepted_tokens = 3;

  // Drafter truncates its local KV cache beyond this position before
  // injecting accepted_tokens.
  uint64 position = 4;

  uint32 max_draft_tokens = 5;
  bool greedy = 6;
}

message DraftResponse {
  uint64 session_id = 1;
  uint64 step_id = 2;

  repeated int32 draft_tokens = 3;
  repeated float draft_logprobs = 4;
  // Per-position predicted acceptance from the DSpark confidence head,
  // read via llama_get_embeddings_nextn(ctx_dft) — available when the
  // checkpoint has dspark_conf_proj. Empty otherwise.
  repeated float confidence = 5;

  uint32 draft_us = 6;
  bool ok = 7;
  string error = 8;
}

message ResetRequest {
  uint64 session_id = 1;
}

message ResetResponse {
  bool ok = 1;
}
```

---

## 9. Server-Side llama.cpp Work

Add a new speculative decoding mode:

```text
draft-remote-dspark
```

This should behave like local `draft-dspark`, except the DSpark draft call is replaced by a gRPC request.

The server loop should be approximately:

```cpp
// After target prefill: extract tap-layer hidden states for every prompt
// token and ship them via Prefill (chunked) before the first Draft call.

while (!done) {
    // 1. Server owns target prefix and KV cache. The previous verify pass
    //    produced tap-layer hidden states for every newly accepted token
    //    (llama_get_embeddings_nextn path, layers from InitSessionResponse).
    auto accepted = collect_accepted_token_features(target_ctx, slot);

    // 2. Build remote draft request: accepted tokens + their features.
    DraftRequest req;
    req.session_id = slot.remote_dspark_session_id;
    req.step_id = slot.decode_step++;
    req.position = slot.n_past;
    for (auto & t : accepted) {
        add_token_features(req, t.token, t.position, pack_bf16(t.features));
    }
    req.max_draft_tokens = 7;
    req.greedy = true;

    // 3. The edge daemon injects the features into its local draft KV cache,
    //    truncates rejected positions, and drafts the next block.
    auto draft = remote_dspark_client.Draft(req);

    // 4. Verify returned token IDs with target model. This same pass
    //    produces the hidden states for the next Draft call.
    auto verify_result = verify_draft_tokens_with_target(slot, draft.draft_tokens);

    // 5. Accept longest valid prefix.
    commit_accepted_tokens(slot, verify_result);

    // 6. Stream only final verified tokens to client.
}
```

Note: the local DSpark path extracts embeddings at one configured layer; the
remote split needs all 5 tap layers extracted in a single target pass. Verify
early that `llama_set_embeddings_layer_inp` / the PR's extraction plumbing
supports multiple simultaneous layers — this may need a small patch.

Important: reuse the existing local speculative verification path as much as possible. Do not reimplement acceptance logic unless necessary.

---

## 10. Edge-Daemon Work

Add a small DSpark draft runtime around the DSpark GGUF loader.

Target function shape:

```cpp
dspark_block draft_from_features(
    llama_context * draft_ctx,
    const dspark_token_features * accepted,  // token id + position + packed features
    size_t n_accepted,
    uint64_t position,        // truncate draft KV beyond this first
    int max_draft_tokens
);
```

The daemon should:

1. Load DSpark model.
2. Accept `InitSession`; reply with tap layer IDs, hidden size, block size, dtype.
3. Keep a per-session draft KV cache (this mirrors the local DFlash `process()` path,
   which decodes injected target embeddings into the draft cache at their positions).
4. Accept `Prefill` chunks; inject every prompt token's features into the draft cache.
5. Accept `DraftRequest`: truncate the draft cache beyond `position`
   (rejected drafts), then inject the accepted tokens' features.
6. Run DSpark block drafting (anchor-first block `[id_last, <mask> × 6]`;
   DSpark samples all `block_size` positions, so a block-7 checkpoint yields
   7 draft tokens).
7. Return draft tokens and confidence.
8. Handle `Reset`.
9. (`--watch`) Render the edge preview: pending drafts immediately in
   gray/italic, verdicts applied when the next `DraftRequest` arrives
   (see §15). Rendering must never block the draft path.

The daemon should not:

- tokenize user text,
- own chat templates,
- sample final output,
- store target KV cache,
- expose a public HTTP API,
- run the full target model.

Portability note (for Phase 2): stick to POSIX / llama.cpp's own
abstractions where cheap, so the QNX port is a recompile.

---

## 11. The Key llama.cpp Refactor

Introduce an abstraction:

```cpp
struct dspark_token_features {
    int32_t  token;
    uint64_t position;
    std::vector<uint8_t> features; // n_tap_layers * hidden_size, packed bf16
};

struct remote_dspark_request {
    uint64_t session_id;
    uint64_t step_id;
    uint64_t position;             // truncate draft KV beyond this
    int32_t  max_draft_tokens;

    std::vector<dspark_token_features> accepted_tokens;
};

struct remote_dspark_response {
    uint64_t session_id;
    uint64_t step_id;
    std::vector<int32_t> draft_tokens;
    std::vector<float> draft_logprobs;
    std::vector<float> confidence;
};

class dspark_drafter {
public:
    virtual ~dspark_drafter() = default;
    virtual remote_dspark_response draft(const remote_dspark_request & req) = 0;
};

class local_dspark_drafter final : public dspark_drafter {
    // Existing in-process DSpark path.
};

class grpc_dspark_drafter final : public dspark_drafter {
    // Calls the edge daemon.
};
```

Then make `draft-dspark` use the local implementation and `draft-remote-dspark` use the gRPC implementation.

Do not write these from scratch: `local_dspark_drafter` *is* the existing
`common_speculative_impl_draft_dflash`, and the remote pair is its two
halves split at the `process()` / `draft()` boundary — see the steal list
in §4.

---

## 12. Feature Transport Format

Start with BF16 packed bytes, one `TokenFeatures` entry per token:

```text
feature_dtype = "bf16"
features = hidden states for tap layers [1, 9, 17, 25, 33],
           concatenated in that order, hidden_size (2560) values each
```

Expected sizes (Qwen3-4B, bf16):

```text
per accepted token:  5 layers × 2560 × 2 bytes ≈ 25.6 KB
per decode step:     up to 8 accepted tokens   ≈ 200 KB
prompt prefill:      prompt_len × 25.6 KB
                     (2,000-token prompt ≈ 50 MB, sent once, chunked)
```

That is fine over wired LAN (use Ethernet, not Wi-Fi, for the prefill burst)
and still ~5–6× smaller per token than shipping target KV cache
(~144 KB/token), with no ongoing cache-sync problem. gRPC channel
compression (gzip) can be enabled if desired, though packed bf16
activations are high-entropy so gains are modest.

Later optimization:

```text
feature_dtype = "q8"
features = int8 values + per-layer scale metadata (4× smaller)
```

For hackathon purposes, do not optimize the feature transport until the end-to-end path works.

---

## 13. Webserver Role

The server webserver should not know about DSpark internals.

Recommended process layout:

```text
Browser
  ↓
Webserver
  ↓ localhost HTTP/SSE
Patched llama-server
  ↓ gRPC
Edge DSpark daemon
```

The webserver owns:

```text
auth
UI
conversation state
request routing
SSE/WebSocket bridge
debug page
metrics display
```

The patched `llama-server` owns:

```text
target model
target KV cache
tokenization
chat templates
sampling
hidden feature extraction
remote DSpark calls
draft verification
final token streaming
```

Do not route edge draft tokens through the webserver. That would force the webserver to understand token IDs, speculative positions, slots, cancellation, and verification.

---

## 14. Debug / Metrics Endpoint

For the hackathon, expose speculative stats either from patched `llama-server` or your webserver.

Example:

```http
GET /debug/spec
```

Response:

```json
{
  "remote_dspark": "connected",
  "edge_host": "pi-edge.local:50051",
  "draft_blocks": 128,
  "draft_tokens": 896,
  "accepted_tokens": 612,
  "acceptance_rate": 0.68,
  "avg_edge_draft_ms": 4.7,
  "avg_grpc_ms": 1.2,
  "avg_verify_ms": 9.8,
  "fallback_steps": 3
}
```

This is important for demo clarity. (The edge-side preview CLI in §15 is
independent of this endpoint — it lives entirely on the edge device.)

---

## 15. Edge Preview CLI (`llama-spec-watch`)

A terminal view that runs **on the edge device itself** and exploits the
core property of this architecture: the speculation happens on the edge, so
the edge knows the guessed continuation *before* the server does. The edge
screen shows draft tokens **grayed out and italic the instant they are
drafted** — ahead of the server's verified output — then, when the verdict
comes back, confirms them in place (restyled as normal text) or strikes
them out and shows the server's replacement.

This is the demo centerpiece: the browser shows the normal chat streaming
from the server; next to it, the edge terminal is visibly *ahead*, guessing
the future and getting graded on it in real time.

### The trick: no protocol change needed

The daemon already has everything required:

- It produces the draft block itself → it can display drafts immediately,
  during the window where the server is still verifying (network RTT +
  verify pass — this is exactly the "preview lead" the audience sees).
- The server's verdict arrives implicitly in the **next** `DraftRequest`:
  its `accepted_tokens` list is the surviving prefix of the last draft block
  plus the server's correction token, and `position` marks the truncation
  point. Matching `accepted_tokens` against the last drafted block yields
  confirmed / rejected / replacement with no extra RPC.
- The draft GGUF inherits the target's vocab, so the daemon detokenizes
  locally for display — and since `Prefill` also carries token IDs, the edge
  can render the full transcript, not just the tail.

One caveat: the final draft block of a generation never gets a follow-up
`DraftRequest`, so its verdict would stay pending on screen — resolve it on
`Reset` (or just leave it gray; acceptable for the POC).

### Architecture

```text
llama-dspark-grpcd (edge device)
   ├─ gRPC service (unchanged)
   └─ watch events: JSON lines over a local unix/TCP socket
         ↓
llama-spec-watch (same box, render-only)
```

For the MVP, skip the separate process: build the renderer into the daemon
behind a `--watch` flag that draws directly to the daemon's terminal. An
in-daemon C++ ANSI renderer has zero new dependencies and will port to QNX
unchanged in Phase 2 (Python availability there is uncertain). On Linux a
standalone Python/`rich` client over the local socket is a fine later split.

### Rendering rules

State machine over the transcript tail:

```text
on prefill / accepted tokens arriving:
  render as normal text (this is server-confirmed history)

on producing a draft block:
  append each draft token in gray + italic          (the "pending" region)
  <- this render happens BEFORE the gRPC response is even sent back

on next DraftRequest (the verdict):
  matched prefix of pending tokens -> restyle as normal text   (confirmed)
  first rejected pending token     -> red strikethrough ~200 ms, then remove
  remaining pending tokens         -> remove silently
  server correction token          -> append as normal text, brief highlight
                                      to mark it as server output

on Reset / session end:
  resolve or clear any pending region, print acceptance stats footer
```

Visual timeline for one block (brackets = gray italic pending drafts):

```text
t0:  The quick brown [ fox jumps over the lazy ]   <- edge drafts; server hasn't
                                                      even received this yet
t1:  The quick brown fox jumps over ~~the~~        <- verdict arrives with next
                                                      DraftRequest: 4 confirmed
t2:  The quick brown fox jumps over a              <- server correction token
```

### Implementation notes

- Simplest robust terminal strategy: full redraw of the visible tail on each
  event (clear + reprint last N lines). Hand-rolled cursor math breaks when
  the pending region wraps across lines; a demo transcript is small enough
  that full redraw is free.
- ANSI styling: italic `\x1b[3m`, gray `\x1b[90m`, strikethrough `\x1b[9m`.
  Some terminals don't render italics — fall back to dim (`\x1b[2m`).
- Detokenized pieces can be partial UTF-8 sequences; buffer per region and
  only render complete code points.
- The strike-out flash duration (~200 ms) is a demo knob — make it a flag.
- Optional flourish: when the checkpoint's confidence head is active
  (`DraftResponse.confidence`), shade pending drafts by predicted acceptance.
- Rendering must never block the draft path: draw after sending the
  `DraftResponse`, or from a separate thread. The preview is an observer,
  not a participant.

---

## 16. Failure Behavior

The server must degrade gracefully. No timeout machinery for the POC —
just handle hard failures.

If the edge daemon replies:

```text
use remote DSpark draft block
```

If the edge daemon disconnects or returns an error:

```text
disable remote DSpark for this request
continue serving from the full model
```

Pseudocode:

```cpp
if (!remote_dspark_available) {
    decode_one_token_with_target_only();
    continue;
}
```

This prevents the public webserver from becoming unreliable when the edge side crashes.

---

## 17. Implementation Milestones

All milestones in this phase are Linux-only. Localhost is fine until
Milestone 6; the Pi is just a second Linux box when you get there.

### Milestone 1: Local DSpark on Linux

Goal:

```text
Run llama.cpp DSpark locally with target + draft model in one process.
```

Acceptance criteria:

- `dspark_qwen3_4b_block7` safetensors converted to GGUF with the PR's
  conversion script (`--target-model-dir` pointing at Qwen3-4B).
- `llama-server` or `llama-cli` runs with local `--spec-type draft-dspark`.
- Greedy output is correct.
- Draft acceptance logs or metrics are visible.
- Known prompt produces stable output.

---

### Milestone 2: Standalone Drafter Daemon Skeleton

Goal:

```text
llama-dspark-grpcd builds, loads the DSpark GGUF, and serves the gRPC API
(InitSession answered from GGUF metadata; Draft can return stub data).
```

Acceptance criteria:

- DSpark GGUF loads without unsupported tensor errors.
- DSpark-specific tensors are recognized by name: `markov_w1.weight`,
  `markov_w2.weight`, optional `dspark_conf_proj.{weight,bias}`, and the
  `dflash.block_size` GGUF metadata key (the graph hard-asserts on it).
- `InitSession` returns the correct tap layers / hidden size / block size.
- The daemon starts and waits for RPC calls.

---

### Milestone 3: Golden Trace Dump

Goal:

```text
Instrument the local Linux DSpark path to dump feature packets and expected
draft responses.
```

Artifacts:

```text
golden/prefill_chunk_000.pb
golden/step_0001_request.pb
golden/step_0001_response.pb
golden/step_0002_request.pb
...
```

Acceptance criteria:

- Can replay at least 20 decode steps.
- Dumps are per-token: token id, position, and hidden states for all 5 tap
  layers — for the prompt prefill and for each step's accepted tokens.
- Feature dtype, size, and tap-layer metadata are recorded.
- Draft token outputs are recorded.

---

### Milestone 4: Daemon Replay Mode

Goal:

```text
Run the drafter daemon against golden feature packets, no server involved.
```

Example:

```bash
./llama-dspark-grpcd \
  --model models/dspark_qwen3_4b_block7.gguf \
  --replay golden/
```

Acceptance criteria:

- Replayed drafts match the local in-process DSpark drafts in greedy mode,
  or differences are understood and documented (on the Pi expect some
  NEON-vs-x86 float divergence — acceptance-rate parity matters more than
  exact token equality).
- Feature injection path works independently of the full target model.

---

### Milestone 5: Fake Remote Drafter

Goal:

```text
Patch llama-server with draft-remote-dspark mode but use a fake gRPC drafter.
```

Acceptance criteria:

- Server can call a fake drafter.
- Fake drafter returns hardcoded token IDs.
- Server verifies/rejects them correctly.
- Server continues generation normally.

---

### Milestone 6: Real Remote Drafter

Goal:

```text
Connect patched llama-server to llama-dspark-grpcd — first on localhost,
then with the daemon on the Pi over the LAN.
```

Acceptance criteria:

- Server creates a session (and learns tap layers / block size from the handshake).
- Server ships prompt prefill features, then per-step accepted-token features.
- Daemon returns DSpark draft tokens.
- Server verifies and accepts/rejects.
- Final text streams to web client.
- KV cache never leaves the server.
- Works identically with the daemon on localhost and on the Pi.

---

### Milestone 7: Edge Preview CLI

Goal:

```text
The daemon's --watch mode renders the live speculation preview (§15).
```

Acceptance criteria:

- Pending drafts render gray/italic immediately on drafting.
- The next DraftRequest's verdict confirms / strikes out / replaces in place.
- Rendering demonstrably never blocks the draft path.

---

### Milestone 8: Demo Polish

Goal:

```text
Make the system explainable and observable.
```

Acceptance criteria:

- Web UI or debug endpoint shows:
  - edge connected/disconnected
  - draft blocks
  - accepted tokens
  - acceptance rate
  - average edge draft latency
  - average gRPC latency
  - fallback count
- System gracefully handles edge-daemon crash or disconnect.
- Demo prompt clearly shows streaming output.
- The edge preview shows draft tokens appearing gray/italic *before* the
  server streams them, then confirmed in place or struck out and replaced
  by the server's correction.

---

## 18. Testing Plan

### Correctness Tests

- Greedy baseline without DSpark.
- Local DSpark greedy output.
- Remote DSpark greedy output.
- Confirm final emitted token sequence matches target model behavior under greedy decoding.

### Protocol Tests

- `InitSession` (metadata handshake matches checkpoint config)
- `Prefill` (chunked, drafter KV fill level matches prompt length)
- `Draft` (KV truncation + injection on partial acceptance)
- `Reset`
- malformed request handling
- stale `step_id`
- session reset after cancellation

### Performance Tests

Track:

```text
tokens/sec without speculative decoding
tokens/sec with local DSpark
tokens/sec with remote DSpark (localhost and Pi)
edge draft latency
gRPC latency
server verification latency
acceptance rate
fallback rate
```

### Resilience Tests

- Kill the edge daemon during generation.
- Return empty draft.
- Return invalid token IDs.
- Return draft longer than max block size.
- Restart the edge daemon between requests.

---

## 19. Key Risks

### Risk 1: DSpark PR instability

DSpark support may not be fully upstreamed or stable, and PR #25173 is
force-pushed during review. Keep a clean branch pinned to a known-good
commit.

Mitigation:

```text
Get local Linux DSpark working first (Milestone 1).
Pin the PR commit; never rebase mid-hackathon.
```

---

### Risk 2: Feature injection is harder than expected

The hard part is identifying exactly where DSpark consumes target-side features.

Mitigation:

```text
Instrument local DSpark.
Dump golden feature packets (Milestone 3).
Replay them in the daemon before building live gRPC (Milestone 4).
```

---

### Risk 3: Multi-layer extraction on the server

The remote split needs all 5 tap layers extracted from the target in one
pass; the local path may only be plumbed for its own use.

Mitigation:

```text
Check llama_set_embeddings_nextn / extraction plumbing on day one.
Milestone 3's instrumentation doubles as the proof it works.
```

---

### Risk 4: Edge CPU too slow

The Pi may not draft fast enough to beat server-only decoding.

Mitigation:

```text
Use the smallest viable DSpark checkpoint.
Use block size 7.
Quantize the draft GGUF if the conversion supports it (verify early).
Measure and present architecture even if speedup is modest.
```

For a hackathon, the architectural win may be more important than raw
speedup — and the edge preview (§15) plus acceptance-rate metrics make the
demo compelling regardless.

---

### Risk 5: Network latency erases speedup

Unary gRPC per token block may add overhead.

Mitigation:

```text
Start unary for simplicity.
Keep the gRPC channel/session warm (no per-step reconnects).
Use wired Ethernet.
Move to persistent bidirectional gRPC stream if needed.
Batch only one draft block per call.
```

---

## 20. Phase 2 (later): QNX Port

Not part of the current work. Once client/server/CLI work on Linux, port the
edge daemon to QNX on the same Pi 5 (QNX SDP 8.0 has an official Pi 5 BSP /
quick-start image, 4 GB and 8 GB variants).

Plan sketch:

```text
1. Base on xtang2010/llama.cpp-qnx (CPU-only ggml; latest release tested
   against llama.cpp b8808) — rebase the pinned DSpark PR + our
   remote-dspark work onto it in a qnx-dspark-build branch.
2. Build a minimal llama.cpp binary on QNX; run a small GGUF (old M2).
3. Replay the golden traces from Milestone 3 on QNX (old M5) — this
   validates the port with zero network involvement.
4. Swap the Pi's Linux daemon for the QNX daemon; nothing else changes.
```

Known friction to expect:

```text
C++ gRPC/protobuf on QNX may be painful. Fallback: length-prefixed
protobuf-over-TCP or JSON-over-TCP behind the same dspark_drafter
interface; keep the wire schema identical.
Python is uncertain on QNX — this is why the preview renderer lives
in-daemon (C++), so it ports as-is.
```

---

## 21. Non-Goals

Do not implement these during the current phase unless everything else works:

```text
QNX port (that is Phase 2, §20)
remote KV-cache transfer
remote tensor backend execution
multi-user batching across edge sessions
advanced load balancing
multiple edge drafters
full OpenAI-compatible server on the edge
browser-to-edge communication
complex feature quantization
custom tokenizer service on the edge
lossless sampling at temp > 0 (the protocol carries chosen-token logprobs
only; correct speculative sampling would need full draft distributions —
greedy is the POC contract)
```

---

## 22. Definition of Done

The current phase is successful when:

1. A browser or web client sends a normal chat request to the server webserver.
2. The webserver forwards the request to patched `llama-server`.
3. The server runs the full target model and owns the KV cache.
4. During decoding, the server streams per-token target hidden states (5 tap layers) over gRPC to the edge daemon, which maintains its own local draft KV cache.
5. The edge DSpark daemon returns block draft token suggestions.
6. The server verifies those draft tokens using the target model.
7. The server streams only verified final text back to the user.
8. Debug metrics show draft/acceptance behavior.
9. The edge device's local preview shows speculated tokens gray/italic ahead
   of the server's stream, then confirmed in place or struck out and
   replaced — demonstrating that the edge device is genuinely computing the
   guesses.
10. If the edge daemon fails, the server falls back to normal target decoding without crashing.

All of the above running on Linux (server box + Pi 5 running Linux, or two
Linux boxes). QNX comes after (§20).

The key demo line:

> The edge device accelerates server-side generation by proposing DSpark draft blocks — you can watch it guess the future on its own screen — while the full model and KV cache remain safely on the server.
