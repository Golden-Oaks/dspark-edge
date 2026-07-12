# DSpark Studio — llama.cpp remote speculative decoding dashboard

A local web console for driving this repo's DSpark stack: the patched
`llama-server` (target / main model) and the `llama-dspark-grpcd` edge daemon
(draft model) that talk over gRPC. Configure both, launch them with a button,
watch live speculative-decoding metrics from the server's `/debug/spec`
endpoint, and chat with the target model — all from one page.

## What it does

- **One-click launch.** Configure the target server and edge daemon (model
  paths, ports, ctx size, GPU layers, flash-attn, `n-max`, temp/top-k, threads,
  extra args) and start/stop each — or **Quick start** both in the right order
  (daemon first, then the server handshakes over gRPC).
- **Model presets.** Switch between the `Qwen3-4B` (`dflash`) and
  `Gemma 4 12B` (`dspark`) configurations from the run-demo docs. The Qwen3
  daemon gets `--target-model` automatically; Gemma4 leaves it empty.
- **Live metrics.** Polls `GET /debug/spec` and renders acceptance rate, draft
  blocks/tokens, edge-draft latency, gRPC round-trip latency, and fallback
  steps as KPI cards + Tremor charts, with an edge-connection indicator.
- **Chat.** A streaming chat UI (AI SDK Elements) wired to the target server's
  OpenAI-compatible `/v1/chat/completions`, with an adjustable system prompt
  and temperature.
- **Logs.** Combined, color-coded stdout/stderr from both processes, streamed
  live over SSE with per-process filtering.

## Requirements

Build the binaries first (the dashboard shells out to them):

```bash
# from the repo root
./scripts/init.sh && ./scripts/build.sh
```

The dashboard looks for `build/bin/llama-server` and
`build/tools/llama-dspark-grpcd/llama-dspark-grpcd`, and scans `models/` for
`.gguf` files. Missing binaries surface as a warning in the header; missing
models can be typed in or picked from the folder button.

## Running

```bash
cd tools/llama-dspark-test-ui
npm install
npm run dev        # http://localhost:3000
```

The Node process behind the dashboard spawns and manages the real binaries, so
run it on the same host as the build (or point it elsewhere via env vars).

### Environment overrides

| Variable            | Default                     | Purpose                          |
| ------------------- | --------------------------- | -------------------------------- |
| `DSPARK_REPO_ROOT`  | two levels up from the app  | repo root used to locate things  |
| `DSPARK_BUILD_DIR`  | `<repo>/build`              | where the binaries live          |
| `DSPARK_MODELS_DIR` | `<repo>/models`             | GGUF scan directory              |

Config you set in the UI persists to `.dashboard-config.json` (gitignored) via
the **Save config** button, and is also saved whenever you start a process.

## How it maps to the CLI

The launch buttons assemble the same invocations as `scripts/run_demo.sh`:

- **Server:** `llama-server -m <target> --host --port --ctx-size --n-gpu-layers
  --flash-attn --parallel --temp --top-k [--spec-type draft-remote-dspark
  --spec-draft-remote-grpc <host:port> --spec-draft-n-max <n>]`
- **Daemon:** `llama-dspark-grpcd --model <draft> --host --port --threads
  --ctx-size [--target-model <target>]`

## Stack

Next.js (App Router) · React · Tailwind CSS · shadcn/ui · Tremor-style charts
(Recharts) · AI SDK + AI SDK Elements · Motion · Zustand.
