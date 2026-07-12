"use client";

import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import type { ProcState } from "@/lib/types";

const STATE_META: Record<
  ProcState,
  { label: string; dot: string; text: string; pulse: boolean }
> = {
  stopped: { label: "Stopped", dot: "bg-muted-foreground/50", text: "text-muted-foreground", pulse: false },
  starting: { label: "Starting", dot: "bg-amber-500", text: "text-amber-500", pulse: true },
  running: { label: "Running", dot: "bg-emerald-500", text: "text-emerald-500", pulse: true },
  exited: { label: "Exited", dot: "bg-muted-foreground/50", text: "text-muted-foreground", pulse: false },
  error: { label: "Error", dot: "bg-rose-500", text: "text-rose-500", pulse: false },
};

export function StatusDot({ state, className }: { state: ProcState; className?: string }) {
  const meta = STATE_META[state];
  return (
    <span className={cn("relative flex size-2.5", className)}>
      {meta.pulse && (
        <motion.span
          className={cn("absolute inline-flex size-full rounded-full opacity-60", meta.dot)}
          animate={{ scale: [1, 2.2], opacity: [0.6, 0] }}
          transition={{ duration: 1.4, repeat: Infinity, ease: "easeOut" }}
        />
      )}
      <span className={cn("relative inline-flex size-2.5 rounded-full", meta.dot)} />
    </span>
  );
}

export function StatusBadge({
  state,
  label,
  className,
}: {
  state: ProcState;
  label?: string;
  className?: string;
}) {
  const meta = STATE_META[state];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-xs font-medium",
        className,
      )}
    >
      <StatusDot state={state} />
      <span className={meta.text}>{label ?? meta.label}</span>
    </span>
  );
}
