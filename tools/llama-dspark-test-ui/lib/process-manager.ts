import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type {
  DaemonConfig,
  LogLine,
  ProcId,
  ProcStatus,
  ServerConfig,
} from "./types";
import { exists } from "./paths";

const MAX_LOG_LINES = 4000;

interface ManagedProc {
  child: ChildProcess | null;
  status: ProcStatus;
  logs: LogLine[];
}

class ProcessManager {
  readonly emitter = new EventEmitter();
  private logSeq = 0;
  private procs: Record<ProcId, ManagedProc> = {
    server: this.blankProc("server"),
    daemon: this.blankProc("daemon"),
  };

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  private blankProc(id: ProcId): ManagedProc {
    return {
      child: null,
      logs: [],
      status: {
        id,
        state: "stopped",
        pid: null,
        startedAt: null,
        exitedAt: null,
        exitCode: null,
        signal: null,
        command: null,
        error: null,
      },
    };
  }

  status(id: ProcId): ProcStatus {
    return { ...this.procs[id].status };
  }

  allStatus(): Record<ProcId, ProcStatus> {
    return { server: this.status("server"), daemon: this.status("daemon") };
  }

  logs(id: ProcId, sinceId = 0): LogLine[] {
    return this.procs[id].logs.filter((l) => l.id > sinceId);
  }

  allLogs(sinceId = 0): LogLine[] {
    return [...this.procs.server.logs, ...this.procs.daemon.logs]
      .filter((l) => l.id > sinceId)
      .sort((a, b) => a.id - b.id);
  }

  private pushLog(
    id: ProcId,
    stream: LogLine["stream"],
    text: string,
  ): void {
    const proc = this.procs[id];
    for (const raw of text.split(/\r?\n/)) {
      if (raw.length === 0) continue;
      const line: LogLine = {
        id: ++this.logSeq,
        proc: id,
        stream,
        text: raw,
        ts: Date.now(),
      };
      proc.logs.push(line);
      if (proc.logs.length > MAX_LOG_LINES) proc.logs.shift();
      this.emitter.emit("log", line);
    }
  }

  private updateStatus(id: ProcId, patch: Partial<ProcStatus>): void {
    this.procs[id].status = { ...this.procs[id].status, ...patch };
    this.emitter.emit("status", this.status(id));
  }

  serverArgs(cfg: ServerConfig): string[] {
    const args: string[] = [
      "-m", cfg.targetModel,
      "--host", cfg.host,
      "--port", String(cfg.httpPort),
      "--ctx-size", String(cfg.ctxSize),
      "--n-gpu-layers", String(cfg.nGpuLayers),
      "--flash-attn", cfg.flashAttn,
      "--parallel", String(cfg.parallel),
      "--temp", String(cfg.temp),
      "--top-k", String(cfg.topK),
    ];
    if (cfg.remoteSpec) {
      args.push(
        "--spec-type", "draft-remote-dspark",
        "--spec-draft-remote-grpc", cfg.grpcTarget,
        "--spec-draft-n-max", String(cfg.nMax),
      );
    }
    args.push(...tokenizeExtra(cfg.extraArgs));
    return args;
  }

  daemonArgs(cfg: DaemonConfig): string[] {
    const args: string[] = [
      "--model", cfg.draftModel,
      "--host", cfg.host,
      "--port", String(cfg.grpcPort),
      "--threads", String(cfg.threads),
      "--ctx-size", String(cfg.ctxSize),
    ];
    if (cfg.targetModel.trim()) {
      args.push("--target-model", cfg.targetModel.trim());
    }
    args.push(...tokenizeExtra(cfg.extraArgs));
    return args;
  }

  start(id: ProcId, bin: string, args: string[]): ProcStatus {
    const proc = this.procs[id];
    if (proc.child && proc.status.state === "running") {
      throw new Error(`${id} is already running (pid ${proc.status.pid})`);
    }
    if (!exists(bin)) {
      const msg = `binary not found: ${bin} — build it with scripts/build.sh`;
      this.pushLog(id, "system", `error: ${msg}`);
      this.updateStatus(id, { state: "error", error: msg });
      throw new Error(msg);
    }

    const command = `${bin} ${args.join(" ")}`;
    proc.logs = [];
    this.updateStatus(id, {
      state: "starting",
      pid: null,
      startedAt: Date.now(),
      exitedAt: null,
      exitCode: null,
      signal: null,
      command,
      error: null,
    });
    this.pushLog(id, "system", `$ ${command}`);

    let child: ChildProcess;
    try {
      child = spawn(bin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.pushLog(id, "system", `spawn failed: ${msg}`);
      this.updateStatus(id, { state: "error", error: msg });
      throw err;
    }

    proc.child = child;
    this.updateStatus(id, { state: "running", pid: child.pid ?? null });

    child.stdout?.on("data", (d: Buffer) => this.pushLog(id, "stdout", d.toString()));
    child.stderr?.on("data", (d: Buffer) => this.pushLog(id, "stderr", d.toString()));

    child.on("error", (err) => {
      this.pushLog(id, "system", `process error: ${err.message}`);
      this.updateStatus(id, { state: "error", error: err.message });
    });

    child.on("exit", (code, signal) => {
      proc.child = null;
      const state = code === 0 || signal === "SIGINT" || signal === "SIGTERM" ? "exited" : "error";
      this.pushLog(
        id,
        "system",
        `process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
      );
      this.updateStatus(id, {
        state,
        pid: null,
        exitedAt: Date.now(),
        exitCode: code,
        signal: signal ?? null,
      });
    });

    return this.status(id);
  }

  async stop(id: ProcId): Promise<ProcStatus> {
    const proc = this.procs[id];
    const child = proc.child;
    if (!child || proc.status.pid == null) {
      this.updateStatus(id, { state: "stopped" });
      return this.status(id);
    }
    this.pushLog(id, "system", "stopping…");
    child.kill("SIGINT");
    const pid = proc.status.pid;
    // Escalate if it doesn't exit promptly.
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(t1);
        clearTimeout(t2);
        resolve();
      };
      child.once("exit", done);
      const t1 = setTimeout(() => {
        if (proc.child) proc.child.kill("SIGTERM");
      }, 2500);
      const t2 = setTimeout(() => {
        try {
          if (pid) process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
        done();
      }, 5000);
    });
    return this.status(id);
  }

  startServer(cfg: ServerConfig): ProcStatus {
    return this.start("server", cfg.bin, this.serverArgs(cfg));
  }

  startDaemon(cfg: DaemonConfig): ProcStatus {
    return this.start("daemon", cfg.bin, this.daemonArgs(cfg));
  }
}

function tokenizeExtra(extra: string): string[] {
  const s = extra.trim();
  if (!s) return [];
  // simple shell-ish split honoring quotes
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// Persist the manager across HMR reloads in dev.
const globalForPM = globalThis as unknown as { __dsparkPM?: ProcessManager };
export const processManager: ProcessManager =
  globalForPM.__dsparkPM ?? (globalForPM.__dsparkPM = new ProcessManager());
