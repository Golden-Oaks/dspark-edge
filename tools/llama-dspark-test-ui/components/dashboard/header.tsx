"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useStore } from "@/lib/store";
import { StatusDot } from "./status-badge";
import { Moon, Sun, Zap, TriangleAlert } from "lucide-react";

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      aria-label="Toggle theme"
    >
      {mounted && resolvedTheme === "dark" ? <Moon /> : <Sun />}
    </Button>
  );
}

function MiniStatus({ id, label }: { id: "server" | "daemon"; label: string }) {
  const state = useStore((s) => s.status[id].state);
  return (
    <div className="flex items-center gap-1.5 rounded-full border border-border/60 bg-card/60 px-2.5 py-1">
      <StatusDot state={state} />
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
    </div>
  );
}

function BuildWarning() {
  const paths = useStore((s) => s.paths);
  if (!paths) return null;
  const missing: string[] = [];
  if (!paths.serverBinExists) missing.push("llama-server");
  if (!paths.daemonBinExists) missing.push("llama-dspark-grpcd");
  if (missing.length === 0) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button className="flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-500">
            <TriangleAlert className="size-3.5" />
            {missing.length} binary missing
          </button>
        }
      />
      <TooltipContent className="max-w-xs">
        Not found: {missing.join(", ")}. Build with{" "}
        <span className="font-mono">scripts/build.sh</span>. Looked in{" "}
        <span className="font-mono">{paths.buildDir}</span>.
      </TooltipContent>
    </Tooltip>
  );
}

export function Header() {
  return (
    <motion.header
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-border/60 bg-background/80 px-5 py-3 backdrop-blur-xl"
    >
      <div className="flex items-center gap-3">
        <div className="flex size-9 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-cyan-500 text-white shadow-md shadow-emerald-500/20">
          <Zap className="size-5" />
        </div>
        <div>
          <h1 className="text-sm font-semibold leading-tight tracking-tight">
            DSpark Studio
          </h1>
          <p className="text-[11px] text-muted-foreground">
            Remote speculative decoding · llama.cpp
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <BuildWarning />
        <div className="hidden items-center gap-1.5 sm:flex">
          <MiniStatus id="server" label="Server" />
          <MiniStatus id="daemon" label="Daemon" />
        </div>
        <ThemeToggle />
      </div>
    </motion.header>
  );
}
