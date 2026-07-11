# Models

Place GGUF models here:

```text
models/Qwen3-4B-Q4_K_M.gguf                # target model for the server
models/dspark_qwen3_4b_block7.gguf         # DSpark draft model for the edge daemon
```

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

The DSpark checkpoint is target-specific: use it only with the Qwen3-4B target.
