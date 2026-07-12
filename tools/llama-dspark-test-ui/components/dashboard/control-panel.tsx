"use client";

import { motion } from "motion/react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Rocket, OctagonX, Loader2, Save, RefreshCw, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import { useStore } from "@/lib/store";
import { ServerCard, DaemonCard } from "./launch-cards";

function PresetSelector() {
  const presets = useStore((s) => s.presets);
  const active = useStore((s) => s.config?.activePreset);
  const applyPreset = useStore((s) => s.applyPreset);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Layers className="size-3.5" />
        Model preset
      </div>
      <div className="grid grid-cols-2 gap-2">
        {presets.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => {
              applyPreset(p.id);
              toast.message(`${p.label} preset applied`, { description: p.blurb });
            }}
            className={cn(
              "group relative flex flex-col items-start gap-0.5 rounded-xl border p-3 text-left transition-all",
              active === p.id
                ? "border-primary/50 bg-primary/5 ring-1 ring-primary/30"
                : "border-border/60 bg-card/40 hover:border-border hover:bg-muted/40",
            )}
          >
            <span className="text-sm font-semibold">{p.label}</span>
            <span className="font-mono text-[10px] text-muted-foreground">
              arch: {p.arch}
            </span>
            <span className="mt-0.5 text-[10px] leading-snug text-muted-foreground/80">
              {p.blurb}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function GlobalActions() {
  const runAction = useStore((s) => s.runAction);
  const busy = useStore((s) => s.busy);
  const persist = useStore((s) => s.persist);
  const dirty = useStore((s) => s.dirty);
  const refreshModels = useStore((s) => s.refreshModels);
  const modelsDir = useStore((s) => s.modelsDir);

  const quickstart = async () => {
    toast.message("Launching daemon + server…", {
      description: "Daemon boots first, then the server handshakes over gRPC.",
    });
    const r = await runAction("quickstart");
    if (r.ok) toast.success("Stack launched");
    else toast.error("Quick start failed", { description: r.error });
  };
  const stopAll = async () => {
    const r = await runAction("stop-all");
    if (r.ok) toast.message("All processes stopped");
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        <Button
          onClick={quickstart}
          disabled={busy["quickstart"]}
          className="bg-emerald-600 text-white shadow-sm hover:bg-emerald-600/90"
        >
          {busy["quickstart"] ? <Loader2 className="animate-spin" /> : <Rocket />}
          Quick start
        </Button>
        <Button
          variant="destructive"
          onClick={stopAll}
          disabled={busy["stop-all"]}
        >
          {busy["stop-all"] ? <Loader2 className="animate-spin" /> : <OctagonX />}
          Stop all
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="flex-1"
          onClick={async () => {
            await persist();
            toast.success("Config saved");
          }}
        >
          <Save />
          Save config
          {dirty && <span className="ml-1 size-1.5 rounded-full bg-amber-500" />}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={async () => {
            await refreshModels(modelsDir);
            toast.message("Rescanned models");
          }}
          title="Rescan models directory"
        >
          <RefreshCw />
        </Button>
      </div>
    </div>
  );
}

export function ControlPanel() {
  return (
    <motion.aside
      initial={{ opacity: 0, x: -12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.4 }}
      className="flex w-full flex-col gap-4 lg:w-[420px] lg:shrink-0"
    >
      <div className="rounded-2xl border border-border/60 bg-card/50 p-4 shadow-sm backdrop-blur-sm">
        <PresetSelector />
        <div className="my-4 h-px bg-border/50" />
        <GlobalActions />
      </div>
      <ServerCard />
      <DaemonCard />
    </motion.aside>
  );
}
