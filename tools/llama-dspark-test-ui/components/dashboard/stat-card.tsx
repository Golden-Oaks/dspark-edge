"use client";

import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";
import { AreaChart, type TremorColor } from "@/components/tremor/area-chart";
import type { ChartRow } from "@/components/tremor/area-chart";

export function StatCard({
  label,
  value,
  unit,
  icon: Icon,
  accent = "blue",
  spark,
  sparkKey,
  progress,
  subtle,
}: {
  label: string;
  value: string;
  unit?: string;
  icon?: LucideIcon;
  accent?: TremorColor;
  spark?: ChartRow[];
  sparkKey?: string;
  progress?: number; // 0..100
  subtle?: string;
}) {
  const accentText: Record<TremorColor, string> = {
    blue: "text-blue-500",
    emerald: "text-emerald-500",
    violet: "text-violet-500",
    amber: "text-amber-500",
    rose: "text-rose-500",
    cyan: "text-cyan-500",
    fuchsia: "text-fuchsia-500",
    slate: "text-slate-500",
  };
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
      className="relative flex flex-col gap-2 overflow-hidden rounded-xl border border-border/60 bg-card/60 p-4 shadow-sm"
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        {Icon && <Icon className={cn("size-4", accentText[accent])} />}
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-semibold tabular-nums tracking-tight">{value}</span>
        {unit && <span className="text-sm text-muted-foreground">{unit}</span>}
      </div>
      {subtle && <span className="text-[11px] text-muted-foreground/70">{subtle}</span>}

      {progress != null && (
        <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <motion.div
            className={cn(
              "h-full rounded-full",
              accent === "emerald" && "bg-emerald-500",
              accent === "blue" && "bg-blue-500",
              accent === "violet" && "bg-violet-500",
              accent === "amber" && "bg-amber-500",
              accent === "rose" && "bg-rose-500",
              accent === "cyan" && "bg-cyan-500",
            )}
            initial={false}
            animate={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
            transition={{ type: "spring", stiffness: 120, damping: 20 }}
          />
        </div>
      )}

      {spark && sparkKey && spark.length > 1 && (
        <div className="mt-1 h-10">
          <AreaChart
            data={spark}
            index="t"
            categories={[sparkKey]}
            colors={[accent]}
            showGrid={false}
          />
        </div>
      )}
    </motion.div>
  );
}
