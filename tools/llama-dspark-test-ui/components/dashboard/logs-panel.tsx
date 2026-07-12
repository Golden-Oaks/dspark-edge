"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useStore } from "@/lib/store";
import type { ProcId } from "@/lib/types";
import { Trash2, ArrowDownToLine, Terminal } from "lucide-react";

type Filter = "all" | ProcId;

const PROC_COLOR: Record<ProcId, string> = {
  server: "text-blue-400",
  daemon: "text-violet-400",
};

export function LogsPanel() {
  const logs = useStore((s) => s.logs);
  const clearLogs = useStore((s) => s.clearLogs);
  const [filter, setFilter] = useState<Filter>("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(
    () => (filter === "all" ? logs : logs.filter((l) => l.proc === filter)),
    [logs, filter],
  );

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [filtered, autoScroll]);

  const tabs: { id: Filter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "server", label: "Server" },
    { id: "daemon", label: "Daemon" },
  ];

  return (
    <div className="flex h-[600px] flex-col overflow-hidden rounded-2xl border border-border/60 bg-[#0b0d12] shadow-sm dark:bg-[#0b0d12]">
      <div className="flex items-center justify-between gap-2 border-b border-white/10 bg-white/[0.03] px-3 py-2">
        <div className="flex items-center gap-2">
          <Terminal className="size-4 text-muted-foreground" />
          <div className="flex gap-1 rounded-lg bg-white/5 p-0.5">
            {tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => setFilter(t.id)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  filter === t.id
                    ? "bg-white/10 text-white"
                    : "text-white/50 hover:text-white/80",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setAutoScroll((v) => !v)}
            className={cn(
              "text-white/60 hover:bg-white/10 hover:text-white",
              autoScroll && "text-emerald-400",
            )}
            title="Toggle auto-scroll"
          >
            <ArrowDownToLine />
            {autoScroll ? "Auto" : "Manual"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={clearLogs}
            className="text-white/60 hover:bg-white/10 hover:text-white"
            title="Clear logs"
          >
            <Trash2 />
          </Button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-auto p-3 font-mono text-[11.5px] leading-relaxed"
        onWheel={() => setAutoScroll(false)}
      >
        {filtered.length === 0 ? (
          <div className="flex h-full items-center justify-center text-white/30">
            No output yet. Start a process to see logs stream here.
          </div>
        ) : (
          filtered.map((l) => (
            <div key={l.id} className="flex gap-2 whitespace-pre-wrap break-all">
              <span
                className={cn(
                  "shrink-0 select-none uppercase",
                  PROC_COLOR[l.proc],
                )}
              >
                {l.proc === "server" ? "srv" : "dmn"}
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1",
                  l.stream === "stderr" && "text-amber-300/90",
                  l.stream === "system" && "text-emerald-300/90",
                  l.stream === "stdout" && "text-white/80",
                )}
              >
                {l.text}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
