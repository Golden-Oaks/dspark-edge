import fs from "node:fs";
import type { DashboardConfig, DaemonConfig, Preset, ServerConfig } from "./types";
import {
  configFilePath,
  defaultDaemonBin,
  defaultServerBin,
  modelsDir,
} from "./paths";
import path from "node:path";

export function defaultServerConfig(): ServerConfig {
  return {
    bin: defaultServerBin(),
    targetModel: path.join(modelsDir(), "Qwen3-4B-Q4_K_M.gguf"),
    host: "127.0.0.1",
    httpPort: 8080,
    ctxSize: 4096,
    nGpuLayers: 99,
    flashAttn: "on",
    parallel: 1,
    remoteSpec: true,
    grpcTarget: "127.0.0.1:50051",
    nMax: 7,
    temp: 0,
    topK: 1,
    extraArgs: "",
  };
}

export function defaultDaemonConfig(): DaemonConfig {
  return {
    bin: defaultDaemonBin(),
    draftModel: path.join(modelsDir(), "dspark_qwen3_4b_block7.gguf"),
    targetModel: "",
    host: "127.0.0.1",
    grpcPort: 50051,
    threads: 4,
    ctxSize: 4096,
    extraArgs: "",
  };
}

export function defaultConfig(): DashboardConfig {
  return {
    server: defaultServerConfig(),
    daemon: defaultDaemonConfig(),
    activePreset: "qwen3-gpu",
  };
}

export const PRESETS: Preset[] = [
  {
    id: "qwen3-gpu",
    label: "Qwen3-4B",
    arch: "dflash",
    blurb: "GPU target, flash-attn on. Draft needs --target-model.",
    server: {
      targetModel: path.join(modelsDir(), "Qwen3-4B-Q4_K_M.gguf"),
      nGpuLayers: 99,
      flashAttn: "on",
      ctxSize: 4096,
      nMax: 7,
    },
    daemon: {
      draftModel: path.join(modelsDir(), "dspark_qwen3_4b_block7.gguf"),
      targetModel: path.join(modelsDir(), "Qwen3-4B-Q4_K_M.gguf"),
      ctxSize: 4096,
    },
  },
  {
    id: "gemma-cpu",
    label: "Gemma 4 12B",
    arch: "dspark",
    blurb: "Quantized target, CPU-only. No draft --target-model needed.",
    server: {
      targetModel: path.join(modelsDir(), "gemma-4-12b-it-Q4_0.gguf"),
      nGpuLayers: 0,
      flashAttn: "off",
      ctxSize: 512,
      nMax: 4,
    },
    daemon: {
      draftModel: path.join(modelsDir(), "dspark_gemma4_12b_q4pure.gguf"),
      targetModel: "",
      ctxSize: 512,
    },
  },
];

export function applyPreset(cfg: DashboardConfig, presetId: string): DashboardConfig {
  const preset = PRESETS.find((p) => p.id === presetId);
  if (!preset) return cfg;
  return {
    ...cfg,
    activePreset: presetId,
    server: { ...cfg.server, ...preset.server },
    daemon: { ...cfg.daemon, ...preset.daemon },
  };
}

export function loadConfig(): DashboardConfig {
  const base = defaultConfig();
  try {
    const raw = fs.readFileSync(configFilePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<DashboardConfig>;
    return {
      activePreset: parsed.activePreset ?? base.activePreset,
      server: { ...base.server, ...(parsed.server ?? {}) },
      daemon: { ...base.daemon, ...(parsed.daemon ?? {}) },
    };
  } catch {
    return base;
  }
}

export function saveConfig(cfg: DashboardConfig): void {
  try {
    fs.writeFileSync(configFilePath(), JSON.stringify(cfg, null, 2), "utf8");
  } catch {
    // best-effort persistence; ignore write failures
  }
}
