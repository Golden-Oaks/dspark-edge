# Models

Place GGUF models here:

```text
# Qwen3 (arch "dflash")
models/Qwen3-4B-Q4_K_M.gguf                # target model for the server
models/dspark_qwen3_4b_block7.gguf         # DSpark draft model for the edge daemon

# Gemma 4 12B (arch "dspark")
models/gemma-4-12B-it.gguf                 # target model for the server (bf16 or a quant)
models/dspark_gemma4_12b_q4pure.gguf       # DSpark draft model for the edge daemon
```

The exact artifacts, URLs, and SHA-256 sums are pinned in `../models.lock`.

## Obtaining the models

1. Target model: download a Qwen3-4B GGUF from
   <https://huggingface.co/Qwen/Qwen3-4B> or use `llama.cpp/gguf-py` to convert
   from Safetensors.

2. DSpark draft model:
   - Safetensors: <https://huggingface.co/deepseek-ai/dspark_qwen3_4b_block7>
   - Convert to GGUF using the conversion script in the pinned llama.cpp
     branch:
     ```bash
     python3 third_party/llama.cpp/convert_hf_to_gguf.py \
       deepseek-ai/dspark_qwen3_4b_block7 \
       --target-model-dir path/to/Qwen3-4B \
       --outfile models/dspark_qwen3_4b_block7.gguf
     ```

3. Gemma 4 12B DSpark draft model (arch `dspark`):
   - Converted GGUF: <https://huggingface.co/ankk98/dspark-gemma4-12b-block7-Q4_0-GGUF>
   - Or convert from the HF checkpoint with the Gemma4 DSpark converter:
     ```bash
     python3 third_party/llama.cpp/convert_hf_to_gguf.py \
       deepseek-ai/dspark_gemma4_12b_block7 \
       --target-model-dir path/to/gemma-4-12B-it \
       --outtype bf16 --outfile models/dspark_gemma4_12b_bf16.gguf
     # then quantize to Q4_0 with llama-quantize --pure
     ```

The DSpark checkpoint is target-specific: pair the Qwen3 draft with a Qwen3-4B
target and the Gemma4 draft with a gemma-4-12B-it target.
