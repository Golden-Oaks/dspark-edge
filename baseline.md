# DSpark Baseline — Exact Gemma-compatible llama.cpp fork

> Resolves `plan-review.md` **FINDING-001** and `requirements.md` **BASE-001**.
> This is the pinned source baseline for Milestone 1 / P0.

## Fork identification

| Item | Value |
|------|-------|
| Repository | `https://github.com/Ankk98/llama.cpp.git` |
| Branch | `ft-dspark` |
| HEAD commit | `1612172a8e349ec378da7ba26ca37070aac0f690` |
| Upstream | `https://github.com/ggml-org/llama.cpp.git` |
| Merge-base with upstream | `f708a5b2caaee0226c0af220e366785699ba41e2` (2026-06-30) |
| Divergence | **24 commits ahead**, **126 commits behind** `ggml-org/llama.cpp:master` (as of 2026-07-11) |
| License | MIT (same as upstream llama.cpp) |

Clone and checkout:

```bash
git clone https://github.com/Ankk98/llama.cpp.git llama.cpp-dspark-baseline
cd llama.cpp-dspark-baseline
git checkout ft-dspark
git rev-parse HEAD   # 1612172a8e349ec378da7ba26ca37070aac0f690
```

Why this fork and not `wjinxu/llama.cpp:dspark-upstream`: the upstream PR branch (`ggml-org/llama.cpp#25173`) is Qwen3-only and explicitly documents that Gemma4 support is a follow-up. The `Ankk98/llama.cpp:ft-dspark` branch is the one used to build and convert the public `dspark_gemma4_12b_q4pure.gguf` artifact and contains the `Gemma4DSparkModel` converter plus the `LLM_ARCH_DSPARK` graph.

## Upstream relationship

The branch is a fork of `ggml-org/llama.cpp`. The local DSpark work is rebased on top of upstream commit `f708a5b2caaee0226c0af220e366785699ba41e2`; upstream master has since advanced, so the branch is behind upstream by 126 commits but does **not** include those newer upstream changes in the pinned baseline.

GitHub compare URL (full diff of local patches):  
`https://github.com/Ankk98/llama.cpp/compare/ggml-org:master...Ankk98:ft-dspark`

## Local patches (24 commits)

The `ft-dspark` branch adds DSpark speculative-decoding support for Gemma4 on top of the upstream merge base. The commits are:

```text
1612172a speculative: fix CUDA verify correctness and guard batched fast path
126666a Enhance DSpark CUDA VPS setup script with idempotent features and additional options
210882f Merge upstream master (dflash conversion refactor #25110)
0c24307 speculative: default sequential verify and stabilize DSpark harness
3cdba80 docs: add comparison document for vLLM PR #46995 and llama.cpp `ft-dspark`
28f5e99 speculative: fix CUDA verify divergence and add DSpark prefill helper
f2ed68f docs: add NVIDIA CUDA benchmark results and reference documentation
de7d886 speculative: fix partial layer commit and confidence scheduling bench
33fc593 speculative: fix defer layer sync and verify timing for 1.62x fair
82185d4 docs: record f360dae verify hot-path experiment entry
f360dae llama: GPU greedy verify, defer layer D2H, verify graph warmup
843457e bench: fair vanilla-first harness and honest throughput doc
1762a0d docs: record 1.78x peak coding throughput in benchmark log
bdf0f03 speculative: pp/tgp throughput table and verify hot-path sync skip
889ae10 speculative: adaptive upscale, verify profiling, benchmark log
5298fbd speculative: shorter DSpark draft blocks and fairer benchmarks
05ecf8a speculative: 1.5x+ DSpark verify path on code (n_max=5, c=1024)
7623c81 speculative: batched DSpark verify with greedy accept fast-path
0137633 Refactor speculative decoding process in test files
a9772c2 Implement fused GPU block sampling for DSpark in speculative decoding
3e83f22 Refactor speculative decoding logic in common_speculative.cpp
9c5be32 Enhance DSpark Markov head support with GPU offloading
37220c8 Add debug output for speculative decoding steps in compare_vanilla_speculative.cpp
aed74ef Implement DSpark support in llama.cpp
```

Patch themes:

* **Converter** — add `Gemma4DSparkModel` and `LLM_ARCH_DSPARK` GGUF metadata.
* **Model graph** — new `src/models/dspark.cpp` encoder/decoder with Gemma4-specific attention, RoPE, softcap, and `k_eq_v` handling.
* **Speculative driver** — new `draft-dspark` path in `common/speculative.cpp`, CPU/GPU Markov head, confidence truncation, batched and sequential verify paths.
* **Public API extensions** — `llama-ext.h` structs and helpers for DSpark CPU/GPU sampling.
* **Benchmark harness** — `tests/compare_vanilla_speculative.cpp` plus docs for parity and performance validation.
* **CUDA correctness fixes** — sequential verify made default, batched verify guarded behind `DSPARK_VERIFY_BATCHED=1`.

## Gemma-specific files and changes

### Conversion

* `conversion/gemma.py` — new `Gemma4DSparkModel` class:
  * Registered for HF architecture `Gemma4DSparkModel`.
  * Inherits from `Gemma4Model`; emits `MODEL_ARCH.DSPARK`.
  * Requires `--target-model-dir` to pull tokenizer from the target model.
  * Reads `target_layer_ids` from HF config and writes `dspark.target_layers = [i + 1 for i in target_layer_ids]`.
  * Writes DSpark metadata: `block_size`, `markov_rank`, `markov_head_type`, `enable_confidence_head`, `confidence_head_with_markov`, `causal_attention=False`.
  * Filters out `v_proj` and `v_norm.weight` tensors because `attention_k_eq_v = true`.
  * Handles `embed_tokens.weight` via `TextModel.modify_tensors` so the draft GGUF is self-contained.

### Model graph (`LLM_ARCH_DSPARK`)

* `src/models/dspark.cpp` — new model implementation:
  * `graph<true>` = encoder that fuses raw target-layer features (`target_layers * target_hidden_size`) into draft KV.
  * `graph<false>` = decoder that runs the non-causal noise block over injected context KV.
  * Loads Markov head weights (`markov.w1`, `markov.w2`) and optional confidence head (`confidence.proj` + bias).
* `src/llama-model.cpp` / `src/llama-hparams.h` — add `LLM_ARCH_DSPARK` factory and hparams (`dspark_block_size`, `markov_rank`, `enable_confidence_head`, ...).
* `src/llama-graph.cpp` / `src/llama-graph.h` — reuse DFlash-style encoder/decoder inputs; no new dual-stream graph input.
* `gguf-py/gguf/constants.py` / `tensor_mapping.py` — add `MODEL_ARCH.DSPARK`, DSpark tensor enums (`MARKOV_W1`, `MARKOV_W2`, `CONFIDENCE_PROJ`), and tensor-name mapping.

### Gemma4-specific graph behavior

| Feature | Gemma4 DSpark implementation |
|---------|------------------------------|
| Embedding | `Gemma4TextScaledWordEmbedding` — scale by `sqrt(hidden_size)` applied in graph, not baked into `token_embd.weight` |
| Attention `k_eq_v` | No `v_proj`; V = K; no `v_norm.weight` learnable scale |
| Attention scale | `1.0` (not `1/sqrt(d)`) |
| RoPE | Proportional, `partial_rotary_factor = 0.25` |
| Logits | `tanh(logits / 30.0) * 30.0` after `lm_head`, **before** Markov bias |
| Norms | `input_layernorm`, `post_attention_layernorm`, `pre_feedforward_layernorm`, `post_feedforward_layernorm`, plus per-layer `layer_scalar` (all-ones no-op in released checkpoints) |
| Attention mode | Fully bidirectional (`attention_mask=None`, `is_causal=False`) — loader sets `dspark.attention.causal = 0` |

### Target-layer mapping

From the released checkpoint `deepseek-ai/dspark_gemma4_12b_block7` (`config.json`):

```json
"target_layer_ids": [5, 17, 29, 41, 46]
```

The converter maps 0-based decoder-output indices to layer-input indices used by `llama_set_embeddings_layer_inp`:

```text
GGUF dspark.target_layers = [6, 18, 30, 42, 47]
```

## DSpark-specific files (non-Gemma-only)

These files are changed or added specifically for the DSpark speculative driver and are not generic Gemma4 support:

* `common/arg.cpp` — new CLI flags: `--input-ids`, `--dspark-confidence-threshold`, `--dspark-disable-markov`, etc.
* `common/common.cpp` / `common/common.h` — `common_params_speculative` DSpark fields, `common_load_input_ids_json` helper.
* `common/sampling.cpp` / `common/sampling.h` — `common_sampler_sample_and_accept_n_dspark` for rejection sampling with post-Markov draft probabilities.
* `common/speculative.cpp` / `common/speculative.h` — `common_speculative_impl_draft_dspark`, prefill/verify/process helpers.
* `include/llama.h` / `src/llama-ext.h` — public API additions: `llama_dspark_spec_cpu`, `llama_dspark_markov_gpu`, `llama_dspark_block_sample_gpu`.
* `src/llama-context.cpp` / `src/llama-context.h` — layer-input extraction toggle for target features.
* `tests/compare_vanilla_speculative.cpp` — parity harness used for the baseline gate.
* `tests/smoke_phase1_convert.py`, `tests/smoke_phase2_graph.cpp`, `tests/smoke_phase3a_speculative.cpp`, etc. — phase smoke tests.
* `docs/dspark-*.md` — implementation plan, validation, benchmark logs, HF release notes.

## Tensor sharing

*Decision (Strategy A, locked in the fork):* load `token_embd` and `output` (lm_head) from the **draft GGUF**, not from the target model via `ctx_other`.

Rationale: the DeepSpec checkpoint already ships `embed_tokens.weight` and `lm_head.weight`. Loading them from the draft avoids silent mismatch when the target is quantized differently from the frozen draft copy. The draft GGUF is therefore **self-contained**; the target model is only used at conversion time for the tokenizer and at runtime for feature extraction / verification. Although the original Gemma target ties the embedding and output matrices, the released draft stores them as two separate quantized tensors (`token_embd.weight` and `output.weight`), so they are not aliased at the GGUF level.

## Required GGUF metadata

A valid Gemma4 DSpark draft GGUF must contain these metadata keys (example values from `deepseek-ai/dspark_gemma4_12b_block7`):

| Key | Example | Source |
|-----|---------|--------|
| `general.architecture` | `dspark` | `MODEL_ARCH.DSPARK` |
| `dspark.block_size` | `7` | HF `block_size` |
| `dspark.target_layers` | `[6, 18, 30, 42, 47]` | HF `target_layer_ids` + 1 |
| `dspark.markov_rank` | `256` | HF `markov_rank` |
| `dspark.markov_head_type` | `"vanilla"` | HF `markov_head_type` |
| `dspark.enable_confidence_head` | `true` | HF `enable_confidence_head` |
| `dspark.confidence_head_with_markov` | `true` | HF `confidence_head_with_markov` |
| `dspark.attention.causal` | `0` | hard-coded `add_causal_attention(False)` |
| `tokenizer.ggml.mask_token_id` | `4` | HF `mask_token_id` |

The loader requires `dspark.target_layers`. If `markov_rank > 0`, `dspark.markov_head_type` must be `"vanilla"`; other Markov head types (`gated`, `rnn`) are not supported in this baseline.

### Required tensors

> Resolves `requirements.md` **BASE-003** and `plan-review.md` **FINDING-002**.

The inventory below was extracted directly from the released draft GGUF
`dspark_gemma4_12b_q4pure.gguf` (1.81 GiB on disk, SHA-256 in `models.lock`).
All 75 tensors in the file are required by the worker because the draft model is
self-contained: the worker does **not** load the Gemma 4 12B target transformer.

Key findings:

* **Token embeddings** are copied into the draft GGUF (`token_embd.weight`).
* **Output head** is stored as a separate `output.weight` tensor in the GGUF. In the
  original Gemma target the embedding and output matrices are tied, but the released
  DSpark checkpoint keeps a quantized copy of the target `lm_head` inside the draft
  file. At the GGUF level it is therefore a *tied copy*, not a single shared tensor.
* **Target model** is not loaded by the draft runtime; only target-derived feature
  vectors are injected at runtime.
* **Target-layer IDs** requested by the draft are
  `dspark.target_layers = [6, 18, 30, 42, 47]` (0-based source IDs were
  `[5, 17, 29, 41, 46]`).
* **Feature tensor shape** per token is `[5, 3840]` flattened as `19200` float32
  values, matching `fc.weight` shape `19200 × 3840`.
* **Draft block semantics**: `dspark.block_size = 7`, `dspark.block_count = 5`,
  fully bidirectional (`dspark.attention.causal = False`).

| Tensor | Shape | DType | File size | Runtime size (F32) | Tied | Quantizable | Required on worker |
|---|---|---|---|---|---|---|---|
| token_embd.weight | 3840 × 262144 | Q4_0 | 540.00 MiB | 3.75 GiB | yes | yes | yes |
| output.weight | 3840 × 262144 | Q4_0 | 540.00 MiB | 3.75 GiB | tied-copy | yes | yes |
| fc.weight | 19200 × 3840 | Q4_0 | 39.55 MiB | 281.25 MiB | no | yes | yes |
| enc.output_norm.weight | 3840 | F32 | 15.00 KiB | 15.00 KiB | no | no | yes |
| output_norm.weight | 3840 | F32 | 15.00 KiB | 15.00 KiB | no | no | yes |
| markov.w1.weight | 256 × 262144 | Q4_0 | 36.00 MiB | 256.00 MiB | no | yes | yes |
| markov.w2.weight | 256 × 262144 | Q4_0 | 36.00 MiB | 256.00 MiB | no | yes | yes |
| confidence.proj.bias | 1 | F32 | 32.00 B | 4.00 B | no | no | yes |
| confidence.proj.weight | 4096 | TQ2_0 | 8.00 KiB | 16.00 KiB | no | yes | yes |
| rope_freqs.weight | 256 | F32 | 1.00 KiB | 1.00 KiB | no | no | yes |
| blk.0.attn_k.weight | 3840 × 512 | Q4_0 | 1.05 MiB | 7.50 MiB | no | yes | yes |
| blk.0.attn_k_norm.weight | 512 | F32 | 2.00 KiB | 2.00 KiB | no | no | yes |
| blk.0.attn_norm.weight | 3840 | F32 | 15.00 KiB | 15.00 KiB | no | no | yes |
| blk.0.attn_output.weight | 8192 × 3840 | Q4_0 | 16.88 MiB | 120.00 MiB | no | yes | yes |
| blk.0.attn_q.weight | 3840 × 8192 | Q4_0 | 16.88 MiB | 120.00 MiB | no | yes | yes |
| blk.0.attn_q_norm.weight | 512 | F32 | 2.00 KiB | 2.00 KiB | no | no | yes |
| blk.0.ffn_down.weight | 15360 × 3840 | Q4_0 | 31.64 MiB | 225.00 MiB | no | yes | yes |
| blk.0.ffn_gate.weight | 3840 × 15360 | Q4_0 | 31.64 MiB | 225.00 MiB | no | yes | yes |
| blk.0.ffn_norm.weight | 3840 | F32 | 15.00 KiB | 15.00 KiB | no | no | yes |
| blk.0.ffn_up.weight | 3840 × 15360 | Q4_0 | 31.64 MiB | 225.00 MiB | no | yes | yes |
| blk.0.layer_output_scale.weight | 1 | F32 | 32.00 B | 4.00 B | no | no | yes |
| blk.0.post_attention_norm.weight | 3840 | F32 | 15.00 KiB | 15.00 KiB | no | no | yes |
| blk.0.post_ffw_norm.weight | 3840 | F32 | 15.00 KiB | 15.00 KiB | no | no | yes |
| blk.1.attn_k.weight | 3840 × 512 | Q4_0 | 1.05 MiB | 7.50 MiB | no | yes | yes |
| blk.1.attn_k_norm.weight | 512 | F32 | 2.00 KiB | 2.00 KiB | no | no | yes |
| blk.1.attn_norm.weight | 3840 | F32 | 15.00 KiB | 15.00 KiB | no | no | yes |
| blk.1.attn_output.weight | 8192 × 3840 | Q4_0 | 16.88 MiB | 120.00 MiB | no | yes | yes |
| blk.1.attn_q.weight | 3840 × 8192 | Q4_0 | 16.88 MiB | 120.00 MiB | no | yes | yes |
| blk.1.attn_q_norm.weight | 512 | F32 | 2.00 KiB | 2.00 KiB | no | no | yes |
| blk.1.ffn_down.weight | 15360 × 3840 | Q4_0 | 31.64 MiB | 225.00 MiB | no | yes | yes |
| blk.1.ffn_gate.weight | 3840 × 15360 | Q4_0 | 31.64 MiB | 225.00 MiB | no | yes | yes |
| blk.1.ffn_norm.weight | 3840 | F32 | 15.00 KiB | 15.00 KiB | no | no | yes |
| blk.1.ffn_up.weight | 3840 × 15360 | Q4_0 | 31.64 MiB | 225.00 MiB | no | yes | yes |
| blk.1.layer_output_scale.weight | 1 | F32 | 32.00 B | 4.00 B | no | no | yes |
| blk.1.post_attention_norm.weight | 3840 | F32 | 15.00 KiB | 15.00 KiB | no | no | yes |
| blk.1.post_ffw_norm.weight | 3840 | F32 | 15.00 KiB | 15.00 KiB | no | no | yes |
| blk.2.attn_k.weight | 3840 × 512 | Q4_0 | 1.05 MiB | 7.50 MiB | no | yes | yes |
| blk.2.attn_k_norm.weight | 512 | F32 | 2.00 KiB | 2.00 KiB | no | no | yes |
| blk.2.attn_norm.weight | 3840 | F32 | 15.00 KiB | 15.00 KiB | no | no | yes |
| blk.2.attn_output.weight | 8192 × 3840 | Q4_0 | 16.88 MiB | 120.00 MiB | no | yes | yes |
| blk.2.attn_q.weight | 3840 × 8192 | Q4_0 | 16.88 MiB | 120.00 MiB | no | yes | yes |
| blk.2.attn_q_norm.weight | 512 | F32 | 2.00 KiB | 2.00 KiB | no | no | yes |
| blk.2.ffn_down.weight | 15360 × 3840 | Q4_0 | 31.64 MiB | 225.00 MiB | no | yes | yes |
| blk.2.ffn_gate.weight | 3840 × 15360 | Q4_0 | 31.64 MiB | 225.00 MiB | no | yes | yes |
| blk.2.ffn_norm.weight | 3840 | F32 | 15.00 KiB | 15.00 KiB | no | no | yes |
| blk.2.ffn_up.weight | 3840 × 15360 | Q4_0 | 31.64 MiB | 225.00 MiB | no | yes | yes |
| blk.2.layer_output_scale.weight | 1 | F32 | 32.00 B | 4.00 B | no | no | yes |
| blk.2.post_attention_norm.weight | 3840 | F32 | 15.00 KiB | 15.00 KiB | no | no | yes |
| blk.2.post_ffw_norm.weight | 3840 | F32 | 15.00 KiB | 15.00 KiB | no | no | yes |
| blk.3.attn_k.weight | 3840 × 512 | Q4_0 | 1.05 MiB | 7.50 MiB | no | yes | yes |
| blk.3.attn_k_norm.weight | 512 | F32 | 2.00 KiB | 2.00 KiB | no | no | yes |
| blk.3.attn_norm.weight | 3840 | F32 | 15.00 KiB | 15.00 KiB | no | no | yes |
| blk.3.attn_output.weight | 8192 × 3840 | Q4_0 | 16.88 MiB | 120.00 MiB | no | yes | yes |
| blk.3.attn_q.weight | 3840 × 8192 | Q4_0 | 16.88 MiB | 120.00 MiB | no | yes | yes |
| blk.3.attn_q_norm.weight | 512 | F32 | 2.00 KiB | 2.00 KiB | no | no | yes |
| blk.3.ffn_down.weight | 15360 × 3840 | Q4_0 | 31.64 MiB | 225.00 MiB | no | yes | yes |
| blk.3.ffn_gate.weight | 3840 × 15360 | Q4_0 | 31.64 MiB | 225.00 MiB | no | yes | yes |
| blk.3.ffn_norm.weight | 3840 | F32 | 15.00 KiB | 15.00 KiB | no | no | yes |
| blk.3.ffn_up.weight | 3840 × 15360 | Q4_0 | 31.64 MiB | 225.00 MiB | no | yes | yes |
| blk.3.layer_output_scale.weight | 1 | F32 | 32.00 B | 4.00 B | no | no | yes |
| blk.3.post_attention_norm.weight | 3840 | F32 | 15.00 KiB | 15.00 KiB | no | no | yes |
| blk.3.post_ffw_norm.weight | 3840 | F32 | 15.00 KiB | 15.00 KiB | no | no | yes |
| blk.4.attn_k.weight | 3840 × 512 | Q4_0 | 1.05 MiB | 7.50 MiB | no | yes | yes |
| blk.4.attn_k_norm.weight | 512 | F32 | 2.00 KiB | 2.00 KiB | no | no | yes |
| blk.4.attn_norm.weight | 3840 | F32 | 15.00 KiB | 15.00 KiB | no | no | yes |
| blk.4.attn_output.weight | 8192 × 3840 | Q4_0 | 16.88 MiB | 120.00 MiB | no | yes | yes |
| blk.4.attn_q.weight | 3840 × 8192 | Q4_0 | 16.88 MiB | 120.00 MiB | no | yes | yes |
| blk.4.attn_q_norm.weight | 512 | F32 | 2.00 KiB | 2.00 KiB | no | no | yes |
| blk.4.ffn_down.weight | 15360 × 3840 | Q4_0 | 31.64 MiB | 225.00 MiB | no | yes | yes |
| blk.4.ffn_gate.weight | 3840 × 15360 | Q4_0 | 31.64 MiB | 225.00 MiB | no | yes | yes |
| blk.4.ffn_norm.weight | 3840 | F32 | 15.00 KiB | 15.00 KiB | no | no | yes |
| blk.4.ffn_up.weight | 3840 × 15360 | Q4_0 | 31.64 MiB | 225.00 MiB | no | yes | yes |
| blk.4.layer_output_scale.weight | 1 | F32 | 32.00 B | 4.00 B | no | no | yes |
| blk.4.post_attention_norm.weight | 3840 | F32 | 15.00 KiB | 15.00 KiB | no | no | yes |
| blk.4.post_ffw_norm.weight | 3840 | F32 | 15.02 KiB | 15.00 KiB | no | no | yes |

**Totals:** 1.80 GiB of quantized tensor data in the GGUF (1.81 GiB total file),
12.78 GiB if every tensor were dequantized to float32 at load time.

Tensors that must **not** be present (because `attention_k_eq_v = true`):

```text
blk.{i}.attn_v.weight
blk.{i}.v_norm.weight
```

## Confirmed baseline output

The fork ships a Phase 0 reference trace generated from the DeepSpec PyTorch implementation and a Phase 3a smoke that reproduces it in llama.cpp.

### Reference configuration

| Item | Value |
|------|-------|
| Target model | `google/gemma-4-12B-it` |
| Draft model | `deepseek-ai/dspark_gemma4_12b_block7` |
| Prompt | chat-template wrapped `"The capital of France is"` |
| Temperature | `0` |
| Confidence threshold | `0` |
| Seed | `42` |
| Max new tokens | `32` |

### Reference token stream (from `docs/dspark-port-validation.md`)

Prompt tokens: `18`  
Generated tokens: `9` (stopped early at EOS)

Final output token IDs (prompt + generation):

```text
[2, 105, 2364, 107, 818, 5279, 529, 7001, 563, 106, 107, 105, 4368, 107, 100, 45518, 107, 101,
 818, 5279, 529, 7001, 563, 5213, 50429, 84750, 106]
```

Step 0: `start=18`, `ctx_len=18`, `accepted=4`  
Step 1: `start=23`, `ctx_len=5`, `accepted=3`, generation terminated.

### llama.cpp parity gate

The fork's `compare_vanilla_speculative` harness, when run with a **bf16/f16 target**, reports:

```text
token match: YES
```

This is the in-process baseline the distributed refactor must preserve. Quantized targets are expected to diverge and are not used as the hard parity gate.

### Example invocation

```bash
./build/bin/llama-cli \
  -m /path/to/gemma-4-12B-it-Q4_0.gguf \
  -md ./dspark_gemma4_12b_q4pure.gguf \
  --spec-type draft-dspark \
  --spec-draft-n-max 4 \
  -c 512 -ngl 99 -ngld 99 \
  -p "Your prompt" -n 128 --temp 0
```

## Build configuration

> Resolves `requirements.md` **BASE-001** build and runtime flag pinning.

The canonical reference build is the CUDA configuration used to run the in-process parity gate (`compare_vanilla_speculative`). A local macOS/Metal configure was performed only to verify the fork compiles and to capture host toolchain versions.

### Reference build — Linux CUDA (parity gate)

This matches `scripts/setup-dspark-cuda-vps.sh` in the pinned fork.

| Item | Value |
|------|-------|
| CMake version | `>= 3.14` (project minimum), verified with `4.2.3` locally |
| CMake generator | `Ninja` |
| C compiler | GCC from `build-essential` (Ubuntu), reference arch `x86_64` |
| CXX compiler | G++ from `build-essential` |
| CUDA compiler | `nvcc` from CUDA Toolkit |
| Build type | `Release` |
| Backend selection | `GGML_CUDA=ON` |
| CPU/GPU flags | `CMAKE_CUDA_ARCHITECTURES=86` (RTX 3090; override via `CUDA_ARCH` env) |
| Other CMake flags | `LLAMA_CURL=OFF` |
| Targets built | `compare_vanilla_speculative`, `smoke_batched_logits_repro` |
| Thread count | default (`-1` → all logical cores) |

Reference configure command:

```bash
cmake -S . -B build -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DGGML_CUDA=ON \
  -DCMAKE_CUDA_ARCHITECTURES=86 \
  -DLLAMA_CURL=OFF
```

Reference build command:

```bash
cmake --build build -j$(nproc) \
  --target compare_vanilla_speculative smoke_batched_logits_repro
```

### Local verification build — macOS Metal

Performed on `Darwin 25.2.0 arm64` to verify the pinned commit compiles.

| Item | Value |
|------|-------|
| CMake version | `4.2.3` |
| C compiler | Apple clang 21.0.0 (clang-2100.1.1.101) |
| CXX compiler | Apple clang 21.0.0 (clang-2100.1.1.101) |
| CMake generator | `Ninja` |
| Build type | `Release` |
| Backend selection | `GGML_METAL=ON`, `GGML_BLAS=ON` (Accelerate) |
| CPU/GPU flags | `GGML_CPU_ARM_ARCH=` (unset, `-mcpu=native` used), `GGML_METAL_EMBED_LIBRARY=ON` |
| CMake flags | `LLAMA_CURL=OFF` |
| Configure result | success (`252/252` targets for `compare_vanilla_speculative`) |

> Note: This Metal build is **not** the parity-gate reference. It is recorded only as evidence that the pinned commit builds cleanly on Apple Silicon.

### Runtime configuration

| Item | Value | Source |
|------|-------|--------|
| Context size (`-c`) | `512` | `setup-dspark-cuda-vps.sh` and example invocation |
| Batch size (`-b`) | `2048` | llama.cpp `common_params` default |
| Ubatch size (`-ub`) | `512` | llama.cpp `common_params` default |
| Thread count (`-t`) | unset / default | all logical cores |
| Draft block size | `7` | GGUF `dspark.block_size` |
| Sampling temperature | `0.0` | `--temp 0` greedy |
| Sampling seed | `42` | `--seed 42` |
| GPU offload target | `-ngl 99` | offload all target layers |
| GPU offload draft | `-ngld 99` | offload all draft layers |
| Speculative type | `draft-dspark` | `--spec-type draft-dspark` |
| Max draft tokens | `4` | `--spec-draft-n-max 4` |
| Confidence threshold | `0.0` | `--dspark-confidence-threshold 0` |
| Environment | `DSPARK_NO_ADAPTIVE_NMAX=1` | disables adaptive `n_max` for deterministic baseline |

### Example reference invocation

```bash
DSPARK_NO_ADAPTIVE_NMAX=1 ./build/bin/compare_vanilla_speculative \
  -m /path/to/gemma-4-12B-it.gguf \
  -md /path/to/dspark_gemma4_12b_q4pure.gguf \
  --spec-type draft-dspark \
  --spec-draft-n-max 4 \
  -c 512 -ngl 99 -ngld 99 \
  --temp 0 --seed 42
```

## Conversion command

To regenerate the draft GGUF from the HF checkpoint:

```bash
python convert_hf_to_gguf.py deepseek-ai/dspark_gemma4_12b_block7 \
  --target-model-dir google/gemma-4-12B-it \
  --outtype bf16 \
  --outfile dspark_gemma4_12b_bf16.gguf
```

Then quantize:

```bash
./build/bin/llama-quantize --allow-requantize --pure \
  dspark_gemma4_12b_bf16.gguf dspark_gemma4_12b_q4pure.gguf Q4_0
```

## Reproducing the baseline

The reference run for the P0 gate is recorded in `tests/dspark/fixtures/baseline-results.jsonl`.
To reproduce it from a clean checkout of this repo and a clean clone of the pinned fork:

```bash
# 1. Clone and build the pinned baseline fork (macOS/Metal local verification)
git clone https://github.com/Ankk98/llama.cpp.git llama.cpp-dspark-baseline
cd llama.cpp-dspark-baseline
git checkout ft-dspark
git rev-parse HEAD   # 1612172a8e349ec378da7ba26ca37070aac0f690

cmake -S . -B build -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DGGML_METAL=ON \
  -DGGML_BLAS=ON \
  -DLLAMA_CURL=OFF
cmake --build build -j"$(sysctl -n hw.ncpu)" --target compare_vanilla_speculative

# 2. Apply the per-round instrumentation patch from this repo
patch -p1 < ../distributed-dspark-decoder/scripts/compare_vanilla_speculative-per-round.patch

# 3. Rebuild after patching
cmake --build build -j"$(sysctl -n hw.ncpu)" --target compare_vanilla_speculative

# 4. Run the helper to regenerate the fixture
cd ../distributed-dspark-decoder
scripts/run-baseline.sh
```

The helper runs both target-only (`vanilla`) and in-process DSpark (`draft-dspark`) modes,
post-processes the raw harness output, and writes `tests/dspark/fixtures/baseline-results.jsonl`.

For the CUDA parity-gate reference, build with `-DGGML_CUDA=ON` and
`-DCMAKE_CUDA_ARCHITECTURES=86` (or your GPU architecture) instead of Metal.

## Notes and caveats

* This baseline is **not** the upstream `wjinxu:dspark-upstream` PR branch; that branch is Qwen3-only and explicitly leaves Gemma4 as future work.
* The `ft-dspark` branch is 126 commits behind upstream `ggml-org/llama.cpp:master`. Do not move the baseline forward until the parity gates in later phases explicitly allow it.
* Confidence scheduling (`--dspark-confidence-threshold`) is implemented but defaults to `0` (full block) for the initial parity gate.
* Batched verify is opt-in via `DSPARK_VERIFY_BATCHED=1`; the default sequential path is the correctness baseline on CUDA.
* Markov head types other than `vanilla` are explicitly rejected by the converter and loader.

## Sources

* Fork branch: `https://github.com/Ankk98/llama.cpp/tree/ft-dspark`
* GitHub compare vs upstream: `https://github.com/Ankk98/llama.cpp/compare/ggml-org:master...Ankk98:ft-dspark`
* Hugging Face draft checkpoint: `https://huggingface.co/deepseek-ai/dspark_gemma4_12b_block7`
* Hugging Face converted GGUF: `https://huggingface.co/ankk98/dspark-gemma4-12b-block7-Q4_0-GGUF`
* Upstream DSpark PR (Qwen3-only): `https://github.com/ggml-org/llama.cpp/pull/25173`
