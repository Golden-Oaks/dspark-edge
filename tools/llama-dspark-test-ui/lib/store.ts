"use client";

import { create } from "zustand";
import type {
  DaemonConfig,
  DashboardConfig,
  LogLine,
  ModelEntry,
  PathsInfo,
  Preset,
  ProcId,
  ProcStatus,
  ServerConfig,
  SpecStats,
} from "./types";

export interface SpecResponse {
  base: string;
  reachable: boolean;
  spec: SpecStats | null;
  health: unknown;
  props: unknown;
}

export type SpecPoint = {
  t: string;
  ts: number;
  acceptance: number;
  edgeMs: number;
  grpcMs: number;
  draftTokens: number;
  acceptedTokens: number;
};

type ActionName =
  | "start-server"
  | "stop-server"
  | "start-daemon"
  | "stop-daemon"
  | "quickstart"
  | "stop-all";

const MAX_HISTORY = 120;
const MAX_LOGS = 2000;

interface AppState {
  loaded: boolean;
  config: DashboardConfig | null;
  presets: Preset[];
  paths: PathsInfo | null;
  models: ModelEntry[];
  modelsDir: string;
  status: Record<ProcId, ProcStatus>;
  spec: SpecResponse | null;
  specHistory: SpecPoint[];
  logs: LogLine[];
  busy: Partial<Record<ActionName, boolean>>;
  dirty: boolean;

  init: () => Promise<void>;
  patchServer: (patch: Partial<ServerConfig>) => void;
  patchDaemon: (patch: Partial<DaemonConfig>) => void;
  applyPreset: (id: string) => void;
  persist: () => Promise<void>;
  refreshModels: (dir?: string) => Promise<void>;
  runAction: (action: ActionName) => Promise<{ ok: boolean; error?: string }>;
  pollStatus: () => Promise<void>;
  pollSpec: () => Promise<void>;
  appendLog: (line: LogLine) => void;
  setBacklog: (logs: LogLine[], status: Record<ProcId, ProcStatus>) => void;
  setStatus: (s: ProcStatus) => void;
  clearLogs: () => void;
}

const emptyStatus = (id: ProcId): ProcStatus => ({
  id,
  state: "stopped",
  pid: null,
  startedAt: null,
  exitedAt: null,
  exitCode: null,
  signal: null,
  command: null,
  error: null,
});

export const useStore = create<AppState>((set, get) => ({
  loaded: false,
  config: null,
  presets: [],
  paths: null,
  models: [],
  modelsDir: "",
  status: { server: emptyStatus("server"), daemon: emptyStatus("daemon") },
  spec: null,
  specHistory: [],
  logs: [],
  busy: {},
  dirty: false,

  init: async () => {
    const res = await fetch("/api/config", { cache: "no-store" });
    const data = (await res.json()) as {
      config: DashboardConfig;
      presets: Preset[];
      paths: PathsInfo;
    };
    set({
      config: data.config,
      presets: data.presets,
      paths: data.paths,
      loaded: true,
    });
    await get().refreshModels(data.paths.modelsDir);
    await get().pollStatus();
  },

  patchServer: (patch) =>
    set((s) =>
      s.config
        ? { config: { ...s.config, server: { ...s.config.server, ...patch } }, dirty: true }
        : s,
    ),

  patchDaemon: (patch) =>
    set((s) =>
      s.config
        ? { config: { ...s.config, daemon: { ...s.config.daemon, ...patch } }, dirty: true }
        : s,
    ),

  applyPreset: (id) =>
    set((s) => {
      if (!s.config) return s;
      const preset = s.presets.find((p) => p.id === id);
      if (!preset) return s;
      return {
        dirty: true,
        config: {
          ...s.config,
          activePreset: id,
          server: { ...s.config.server, ...preset.server },
          daemon: { ...s.config.daemon, ...preset.daemon },
        },
      };
    }),

  persist: async () => {
    const cfg = get().config;
    if (!cfg) return;
    await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg),
    });
    set({ dirty: false });
  },

  refreshModels: async (dir) => {
    const q = dir ? `?dir=${encodeURIComponent(dir)}` : "";
    const res = await fetch(`/api/models${q}`, { cache: "no-store" });
    const data = (await res.json()) as { dir: string; models: ModelEntry[] };
    set({ models: data.models, modelsDir: data.dir });
  },

  runAction: async (action) => {
    const cfg = get().config;
    if (!cfg) return { ok: false, error: "config not loaded" };
    set((s) => ({ busy: { ...s.busy, [action]: true } }));
    try {
      const res = await fetch("/api/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, config: cfg }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        status?: Record<ProcId, ProcStatus>;
      };
      if (data.status) set({ status: data.status, dirty: false });
      return { ok: res.ok && !data.error, error: data.error };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      set((s) => ({ busy: { ...s.busy, [action]: false } }));
    }
  },

  pollStatus: async () => {
    try {
      const res = await fetch("/api/process", { cache: "no-store" });
      const data = (await res.json()) as { status: Record<ProcId, ProcStatus> };
      set({ status: data.status });
    } catch {
      /* ignore transient */
    }
  },

  pollSpec: async () => {
    try {
      const res = await fetch("/api/spec", { cache: "no-store" });
      const data = (await res.json()) as SpecResponse;
      set({ spec: data });
      if (data.reachable && data.spec) {
        const s = data.spec;
        const now = Date.now();
        const point: SpecPoint = {
          t: new Date(now).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          }),
          ts: now,
          acceptance: Math.round((s.acceptance_rate ?? 0) * 1000) / 10,
          edgeMs: Math.round((s.avg_edge_draft_ms ?? 0) * 100) / 100,
          grpcMs: Math.round((s.avg_grpc_ms ?? 0) * 100) / 100,
          draftTokens: s.draft_tokens ?? 0,
          acceptedTokens: s.accepted_tokens ?? 0,
        };
        set((st) => ({
          specHistory: [...st.specHistory, point].slice(-MAX_HISTORY),
        }));
      }
    } catch {
      set({ spec: null });
    }
  },

  appendLog: (line) =>
    set((s) => ({ logs: [...s.logs, line].slice(-MAX_LOGS) })),

  setBacklog: (logs, status) => set({ logs: logs.slice(-MAX_LOGS), status }),

  setStatus: (st) =>
    set((s) => ({ status: { ...s.status, [st.id]: st } })),

  clearLogs: () => set({ logs: [] }),
}));

// Re-export for convenience in components.
export type { DashboardConfig, ServerConfig, DaemonConfig, ProcStatus, ProcId };
