import { processManager } from "@/lib/process-manager";
import type { LogLine, ProcStatus } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-Sent Events stream of process logs + status transitions.
 * Emits a backlog of recent lines on connect, then live updates.
 */
export function GET(req: Request) {
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          closed = true;
        }
      };

      // Backlog (last 400 lines across both processes).
      const backlog = processManager.allLogs().slice(-400);
      send("backlog", { logs: backlog, status: processManager.allStatus() });

      const onLog = (line: LogLine) => send("log", line);
      const onStatus = (status: ProcStatus) => send("status", status);
      processManager.emitter.on("log", onLog);
      processManager.emitter.on("status", onStatus);

      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          closed = true;
        }
      }, 15000);

      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        processManager.emitter.off("log", onLog);
        processManager.emitter.off("status", onStatus);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      req.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
