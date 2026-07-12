"use client";

import { motion } from "motion/react";
import {
  Activity,
  Gauge,
  Timer,
  Radio,
  Zap,
  CheckCheck,
  Layers3,
  AlertTriangle,
  PlugZap,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { StatCard } from "./stat-card";
import { AreaChart } from "@/components/tremor/area-chart";
import { cn } from "@/lib/utils";

function ConnectionPill() {
  const spec = useStore((s) => s.spec);
  const connected = spec?.spec?.remote_dspark === "connected";
  const edgeHost = spec?.spec?.edge_host;
  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium",
        connected
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-500"
          : "border-border/60 bg-muted/40 text-muted-foreground",
      )}
    >
      <PlugZap className="size-3.5" />
      {connected ? `edge connected` : "edge disconnected"}
      {edgeHost && connected && (
        <span className="font-mono text-[10px] opacity-70">{edgeHost}</span>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border/60 bg-card/30 p-12 text-center">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-muted/60">
        <Radio className="size-6 text-muted-foreground" />
      </div>
      <div>
        <h3 className="text-sm font-semibold">Waiting for the target server</h3>
        <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
          Start the target server (and edge daemon) to stream live speculative-decoding
          metrics from <span className="font-mono">/debug/spec</span>. Then send a chat
          request to warm up the acceptance stats.
        </p>
      </div>
    </div>
  );
}

export function MetricsPanel() {
  const spec = useStore((s) => s.spec);
  const history = useStore((s) => s.specHistory);
  const stats = spec?.spec ?? null;

  if (!spec?.reachable || !stats) {
    return (
      <div className="flex min-h-[420px] flex-col">
        <EmptyState />
      </div>
    );
  }

  const acceptancePct = (stats.acceptance_rate ?? 0) * 100;
  const fmtInt = (v: number) => v.toLocaleString();
  const fmtMs = (v: number) => `${v.toFixed(2)}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
          <Activity className="size-4" />
          Live speculative decoding
        </h2>
        <ConnectionPill />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          label="Acceptance rate"
          value={acceptancePct.toFixed(1)}
          unit="%"
          icon={Gauge}
          accent="emerald"
          progress={acceptancePct}
          subtle={`${fmtInt(stats.accepted_tokens)} / ${fmtInt(stats.draft_tokens)} tokens`}
        />
        <StatCard
          label="Draft blocks"
          value={fmtInt(stats.draft_blocks)}
          icon={Layers3}
          accent="blue"
          subtle="successful remote draft() calls"
        />
        <StatCard
          label="Edge draft"
          value={fmtMs(stats.avg_edge_draft_ms)}
          unit="ms"
          icon={Zap}
          accent="violet"
          spark={history}
          sparkKey="edgeMs"
          subtle="avg per block"
        />
        <StatCard
          label="gRPC round-trip"
          value={fmtMs(stats.avg_grpc_ms)}
          unit="ms"
          icon={Timer}
          accent="cyan"
          spark={history}
          sparkKey="grpcMs"
          subtle="avg per call"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="lg:col-span-2 flex flex-col gap-3 rounded-2xl border border-border/60 bg-card/60 p-4 shadow-sm"
        >
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Gauge className="size-3.5 text-emerald-500" />
              Acceptance rate over time
            </span>
            <span className="text-lg font-semibold tabular-nums text-emerald-500">
              {acceptancePct.toFixed(1)}%
            </span>
          </div>
          <div className="h-52">
            <AreaChart
              data={history}
              index="t"
              categories={["acceptance"]}
              colors={["emerald"]}
              valueFormatter={(v) => `${v.toFixed(0)}%`}
              yDomain={[0, 100]}
              showXAxis
              showYAxis
            />
          </div>
        </motion.div>

        <div className="flex flex-col gap-3">
          <StatCard
            label="Fallback steps"
            value={fmtInt(stats.fallback_steps)}
            icon={AlertTriangle}
            accent={stats.fallback_steps > 0 ? "amber" : "slate"}
            subtle="remote draft calls that failed"
          />
          <StatCard
            label="Accepted tokens"
            value={fmtInt(stats.accepted_tokens)}
            icon={CheckCheck}
            accent="emerald"
            subtle={`of ${fmtInt(stats.draft_tokens)} proposed`}
          />
        </div>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col gap-3 rounded-2xl border border-border/60 bg-card/60 p-4 shadow-sm"
      >
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Timer className="size-3.5 text-cyan-500" />
          Latency (edge draft vs. gRPC round-trip)
        </span>
        <div className="h-44">
          <AreaChart
            data={history}
            index="t"
            categories={["edgeMs", "grpcMs"]}
            colors={["violet", "cyan"]}
            valueFormatter={(v) => `${v.toFixed(1)} ms`}
            showXAxis
            showYAxis
          />
        </div>
        <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-violet-500" /> edge draft (ms)
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-cyan-500" /> gRPC round-trip (ms)
          </span>
        </div>
      </motion.div>
    </div>
  );
}
