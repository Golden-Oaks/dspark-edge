"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Cpu, Server, Play, Square, RotateCw, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useStore } from "@/lib/store";
import type { ProcId, ProcStatus } from "@/lib/types";
import { StatusBadge } from "./status-badge";
import {
  ChoiceField,
  ModelPicker,
  NumberField,
  SwitchField,
  TextField,
} from "./fields";

function useElapsed(startedAt: number | null, running: boolean): string {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [running]);
  if (!startedAt || !running) return "";
  const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}h ${m}m ${sec}s`
    : m > 0
      ? `${m}m ${sec}s`
      : `${sec}s`;
}

function LaunchControls({
  id,
  status,
}: {
  id: ProcId;
  status: ProcStatus;
}) {
  const runAction = useStore((s) => s.runAction);
  const busy = useStore((s) => s.busy);
  const running = status.state === "running" || status.state === "starting";
  const startAction = id === "server" ? "start-server" : "start-daemon";
  const stopAction = id === "server" ? "stop-server" : "stop-daemon";
  const starting = busy[startAction];
  const stopping = busy[stopAction];

  const doStart = async () => {
    const r = await runAction(startAction);
    if (r.ok) toast.success(`${id} started`);
    else toast.error(`Could not start ${id}`, { description: r.error });
  };
  const doStop = async () => {
    const r = await runAction(stopAction);
    if (r.ok) toast.message(`${id} stopped`);
  };

  if (running) {
    return (
      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          variant="outline"
          onClick={doStart}
          disabled={starting || stopping}
          title="Restart"
        >
          {starting ? <Loader2 className="animate-spin" /> : <RotateCw />}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={doStop}
          disabled={stopping}
        >
          {stopping ? <Loader2 className="animate-spin" /> : <Square />}
          Stop
        </Button>
      </div>
    );
  }
  return (
    <Button
      size="sm"
      onClick={doStart}
      disabled={starting}
      className="bg-emerald-600 text-white hover:bg-emerald-600/90"
    >
      {starting ? <Loader2 className="animate-spin" /> : <Play />}
      Start
    </Button>
  );
}

function CardShell({
  id,
  title,
  subtitle,
  icon: Icon,
  accent,
  children,
}: {
  id: ProcId;
  title: string;
  subtitle: string;
  icon: typeof Server;
  accent: string;
  children: React.ReactNode;
}) {
  const status = useStore((s) => s.status[id]);
  const elapsed = useElapsed(status.startedAt, status.state === "running");
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="flex flex-col gap-4 rounded-2xl border border-border/60 bg-card/70 p-4 shadow-sm backdrop-blur-sm"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3">
          <div className={cn("flex size-9 items-center justify-center rounded-xl", accent)}>
            <Icon className="size-4.5" />
          </div>
          <div>
            <h3 className="text-sm font-semibold leading-tight">{title}</h3>
            <p className="text-xs text-muted-foreground">{subtitle}</p>
          </div>
        </div>
        <LaunchControls id={id} status={status} />
      </div>

      <div className="flex flex-col gap-3">{children}</div>

      <div className="flex items-center justify-between border-t border-border/50 pt-2.5 text-[11px] text-muted-foreground">
        <StatusBadge state={status.state} />
        <span className="tabular-nums">
          {status.state === "running" && status.pid != null
            ? `pid ${status.pid} · ${elapsed}`
            : status.state === "error"
              ? status.error?.slice(0, 48)
              : status.exitCode != null
                ? `exit ${status.exitCode}`
                : "idle"}
        </span>
      </div>
    </motion.div>
  );
}

export function ServerCard() {
  const cfg = useStore((s) => s.config?.server);
  const patch = useStore((s) => s.patchServer);
  const models = useStore((s) => s.models);
  if (!cfg) return null;
  return (
    <CardShell
      id="server"
      title="Target Server"
      subtitle="llama-server · main model"
      icon={Server}
      accent="bg-blue-500/15 text-blue-500"
    >
      <ModelPicker
        label="Main model (target)"
        value={cfg.targetModel}
        onChange={(v) => patch({ targetModel: v })}
        models={models}
        hint="The full target LLM served by llama-server. Owns the KV cache."
      />
      <div className="grid grid-cols-2 gap-3">
        <TextField label="Host" value={cfg.host} onChange={(v) => patch({ host: v })} />
        <NumberField
          label="HTTP port"
          value={cfg.httpPort}
          onChange={(v) => patch({ httpPort: v })}
        />
        <NumberField
          label="Context size"
          value={cfg.ctxSize}
          onChange={(v) => patch({ ctxSize: v })}
          hint="--ctx-size"
        />
        <NumberField
          label="GPU layers"
          value={cfg.nGpuLayers}
          onChange={(v) => patch({ nGpuLayers: v })}
          hint="--n-gpu-layers (0 = CPU only)"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <ChoiceField
          label="Flash attention"
          value={cfg.flashAttn}
          options={[
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
          ]}
          onChange={(v) => patch({ flashAttn: v })}
        />
        <NumberField
          label="Parallel"
          value={cfg.parallel}
          onChange={(v) => patch({ parallel: v })}
          hint="--parallel"
        />
      </div>

      <SwitchField
        label="Remote DSpark speculative decoding"
        checked={cfg.remoteSpec}
        onCheckedChange={(v) => patch({ remoteSpec: v })}
        hint="Enables --spec-type draft-remote-dspark, pointing at the edge daemon."
      />

      {cfg.remoteSpec && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          className="flex flex-col gap-3 overflow-hidden"
        >
          <TextField
            label="Edge gRPC target"
            value={cfg.grpcTarget}
            onChange={(v) => patch({ grpcTarget: v })}
            mono
            hint="host:port of the edge draft daemon (--spec-draft-remote-grpc)"
          />
          <div className="grid grid-cols-3 gap-3">
            <NumberField
              label="n-max"
              value={cfg.nMax}
              onChange={(v) => patch({ nMax: v })}
              hint="max draft tokens/block"
            />
            <NumberField
              label="temp"
              value={cfg.temp}
              onChange={(v) => patch({ temp: v })}
              step={0.05}
            />
            <NumberField
              label="top-k"
              value={cfg.topK}
              onChange={(v) => patch({ topK: v })}
            />
          </div>
        </motion.div>
      )}

      <TextField
        label="Extra args"
        value={cfg.extraArgs}
        onChange={(v) => patch({ extraArgs: v })}
        placeholder="--no-warmup …"
        mono
      />
    </CardShell>
  );
}

export function DaemonCard() {
  const cfg = useStore((s) => s.config?.daemon);
  const patch = useStore((s) => s.patchDaemon);
  const models = useStore((s) => s.models);
  if (!cfg) return null;
  return (
    <CardShell
      id="daemon"
      title="Edge Draft Daemon"
      subtitle="llama-dspark-grpcd · draft model"
      icon={Cpu}
      accent="bg-violet-500/15 text-violet-500"
    >
      <ModelPicker
        label="Draft model (DSpark)"
        value={cfg.draftModel}
        onChange={(v) => patch({ draftModel: v })}
        models={models}
        hint="The lightweight DSpark draft model run on the edge device."
      />
      <ModelPicker
        label="Target model (dflash / Qwen3 only)"
        value={cfg.targetModel}
        onChange={(v) => patch({ targetModel: v })}
        models={models}
        optional
        hint="--target-model. Required for Qwen3 (dflash); leave empty for Gemma4 (dspark)."
      />
      <div className="grid grid-cols-2 gap-3">
        <TextField label="Host" value={cfg.host} onChange={(v) => patch({ host: v })} />
        <NumberField
          label="gRPC port"
          value={cfg.grpcPort}
          onChange={(v) => patch({ grpcPort: v })}
        />
        <NumberField
          label="Threads"
          value={cfg.threads}
          onChange={(v) => patch({ threads: v })}
        />
        <NumberField
          label="Context size"
          value={cfg.ctxSize}
          onChange={(v) => patch({ ctxSize: v })}
        />
      </div>
      <TextField
        label="Extra args"
        value={cfg.extraArgs}
        onChange={(v) => patch({ extraArgs: v })}
        placeholder="--watch …"
        mono
      />
    </CardShell>
  );
}
