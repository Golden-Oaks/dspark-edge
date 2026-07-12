"use client";

import { useEffect } from "react";
import { useStore } from "@/lib/store";
import type { LogLine, ProcId, ProcStatus } from "@/lib/types";

/**
 * Headless component: bootstraps config, subscribes to the log/status SSE
 * stream, and polls /debug/spec on an interval.
 */
export function LiveSync() {
  const init = useStore((s) => s.init);

  useEffect(() => {
    void init();
  }, [init]);

  // SSE: logs + status transitions.
  useEffect(() => {
    const es = new EventSource("/api/logs");
    const { appendLog, setBacklog, setStatus } = useStore.getState();

    es.addEventListener("backlog", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as {
        logs: LogLine[];
        status: Record<ProcId, ProcStatus>;
      };
      setBacklog(data.logs, data.status);
    });
    es.addEventListener("log", (e) => {
      appendLog(JSON.parse((e as MessageEvent).data) as LogLine);
    });
    es.addEventListener("status", (e) => {
      setStatus(JSON.parse((e as MessageEvent).data) as ProcStatus);
    });

    return () => es.close();
  }, []);

  // Poll spec metrics + status fallback.
  useEffect(() => {
    const { pollSpec, pollStatus } = useStore.getState();
    void pollSpec();
    const specTimer = setInterval(() => void pollSpec(), 1500);
    const statusTimer = setInterval(() => void pollStatus(), 5000);
    return () => {
      clearInterval(specTimer);
      clearInterval(statusTimer);
    };
  }, []);

  return null;
}
