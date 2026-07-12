#!/usr/bin/env python3
"""Checkpoint-free tests for the Gemma4 DSpark ("dspark" arch) converter support.

These validate the gguf-py side of the port without needing the multi-GB HF
checkpoint: arch registration, KV-key formatting, writer methods, the HF->GGUF
tensor-name mapping, and (when the real draft GGUF is present) that every tensor
name in the released artifact is a valid output of the DSPARK tensor map.

Run: python3 tests/test_gemma_dspark_convert.py
"""
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "third_party", "llama.cpp", "gguf-py"))
sys.path.insert(0, os.path.join(REPO, "third_party", "llama.cpp"))

import gguf  # noqa: E402

GGUF_PATH = os.path.join(REPO, "models", "dspark_gemma4_12b_q4pure.gguf")

failures = []


def check(cond, msg):
    if cond:
        print(f"  ok: {msg}")
    else:
        print(f"  FAIL: {msg}")
        failures.append(msg)


def test_arch_registered():
    print("[arch registration]")
    check(hasattr(gguf.MODEL_ARCH, "DSPARK"), "MODEL_ARCH.DSPARK exists")
    check(gguf.MODEL_ARCH_NAMES[gguf.MODEL_ARCH.DSPARK] == "dspark",
          'MODEL_ARCH.DSPARK -> "dspark"')


def test_kv_keys():
    print("[KV keys]")
    for name, expect in [
        ("BLOCK_SIZE", "dspark.block_size"),
        ("MARKOV_RANK", "dspark.markov_rank"),
        ("MARKOV_HEAD_TYPE", "dspark.markov_head_type"),
        ("ENABLE_CONFIDENCE_HEAD", "dspark.enable_confidence_head"),
        ("CONFIDENCE_HEAD_WITH_MARKOV", "dspark.confidence_head_with_markov"),
        ("TARGET_LAYERS", "dspark.target_layers"),
    ]:
        got = getattr(gguf.Keys.LLM, name).format(arch="dspark")
        check(got == expect, f"{name} -> {got}")


def test_writer_methods():
    print("[writer methods]")
    for m in ["add_markov_rank", "add_markov_head_type",
              "add_enable_confidence_head", "add_confidence_head_with_markov",
              "add_block_size", "add_target_layers", "add_causal_attention",
              "add_mask_token_id"]:
        check(hasattr(gguf.GGUFWriter, m), f"GGUFWriter.{m}")


def test_tensor_name_map():
    print("[HF -> GGUF tensor names]")
    tmap = gguf.get_tensor_name_map(gguf.MODEL_ARCH.DSPARK, 5)
    cases = {
        "model.markov_head.markov_w1": "markov.w1",
        "model.markov_head.markov_w2": "markov.w2",
        "model.confidence_head.proj": "confidence.proj",
        "model.fc": "fc",
        "model.hidden_norm": "enc.output_norm",
        "model.layers.0.input_layernorm": "blk.0.attn_norm",
        "model.layers.0.post_attention_layernorm": "blk.0.post_attention_norm",
        "model.layers.0.pre_feedforward_layernorm": "blk.0.ffn_norm",
        "model.layers.0.post_feedforward_layernorm": "blk.0.post_ffw_norm",
        "model.layers.0.layer_scalar": "blk.0.layer_output_scale",
        "model.layers.2.self_attn.q_proj": "blk.2.attn_q",
        "model.layers.2.self_attn.k_proj": "blk.2.attn_k",
    }
    for hf, expect in cases.items():
        res = tmap.get_type_and_name(hf, try_suffixes=(".weight", ".bias"))
        got = res[1] if res else None
        check(got == expect, f"{hf} -> {got} (expect {expect})")


def test_converter_class():
    print("[converter registration]")
    import conversion
    cls = conversion.get_model_class("Gemma4DSparkModel")
    check(cls is not None, "Gemma4DSparkModel registered")
    check(cls.model_arch == gguf.MODEL_ARCH.DSPARK, "model_arch == DSPARK")


def test_real_gguf_coverage():
    print("[real GGUF tensor coverage]")
    if not os.path.exists(GGUF_PATH):
        print(f"  skip: {GGUF_PATH} not present")
        return
    r = gguf.GGUFReader(GGUF_PATH)
    names = {t.name for t in r.tensors}
    # Build the full set of GGUF names the DSPARK arch can emit (per block + global).
    valid = set()
    for t in gguf.MODEL_TENSORS[gguf.MODEL_ARCH.DSPARK]:
        base = gguf.TENSOR_NAMES[t]
        if "{bid}" in base:
            for bid in range(5):
                valid.add(base.format(bid=bid) + ".weight")
                valid.add(base.format(bid=bid) + ".bias")
        else:
            valid.add(base + ".weight")
            valid.add(base + ".bias")
    unexpected = sorted(n for n in names if n not in valid)
    check(not unexpected, f"all {len(names)} GGUF tensors covered by DSPARK map"
          + (f"; unexpected={unexpected}" if unexpected else ""))
    # arch metadata
    arch = r.fields["general.architecture"].contents()
    check(arch == "dspark", f'general.architecture == "dspark" (got {arch})')


if __name__ == "__main__":
    test_arch_registered()
    test_kv_keys()
    test_writer_methods()
    test_tensor_name_map()
    test_converter_class()
    test_real_gguf_coverage()
    print()
    if failures:
        print(f"FAILED ({len(failures)} checks)")
        sys.exit(1)
    print("ALL PASSED")
