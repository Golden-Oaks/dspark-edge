export type ProcId = "server" | "daemon";

export interface ServerConfig {
  bin: string;
  targetModel: string;
  host: string;
  httpPort: number;
  ctxSize: number;
  nGpuLayers: number;
  flashAttn: "on" | "off";
  parallel: number;
  /** enable remote DSpark speculative decoding */
  remoteSpec: boolean;
  /** host:port of the edge daemon gRPC endpoint */
  grpcTarget: string;
  nMax: number;
  temp: number;
  topK: number;
  extraArgs: string;
}

export interface DaemonConfig {
  bin: string;
  draftModel: string;
  /** required for dflash (Qwen3) arch; leave empty for dspark (Gemma4) */
  targetModel: string;
  host: string;
  grpcPort: number;
  threads: number;
  ctxSize: number;
  extraArgs: string;
}

export interface DashboardConfig {
  server: ServerConfig;
  daemon: DaemonConfig;
  activePreset: string;
}

export type ProcState = "stopped" | "starting" | "running" | "exited" | "error";

export interface ProcStatus {
  id: ProcId;
  state: ProcState;
  pid: number | null;
  startedAt: number | null;
  exitedAt: number | null;
  exitCode: number | null;
  signal: string | null;
  command: string | null;
  error: string | null;
}

export interface LogLine {
  id: number;
  proc: ProcId;
  stream: "stdout" | "stderr" | "system";
  text: string;
  ts: number;
}

export interface Preset {
  id: string;
  label: string;
  arch: string;
  blurb: string;
  server: Partial<ServerConfig>;
  daemon: Partial<DaemonConfig>;
}

export interface PathsInfo {
  repoRoot: string;
  buildDir: string;
  modelsDir: string;
  serverBin: string;
  daemonBin: string;
  serverBinExists: boolean;
  daemonBinExists: boolean;
}

export interface ModelEntry {
  name: string;
  path: string;
  sizeBytes: number;
}

/** Shape returned by llama-server GET /debug/spec */
export interface SpecStats {
  remote_dspark: "connected" | "disconnected";
  edge_host: string;
  draft_blocks: number;
  draft_tokens: number;
  accepted_tokens: number;
  acceptance_rate: number;
  avg_edge_draft_ms: number;
  avg_grpc_ms: number;
  fallback_steps: number;
}
