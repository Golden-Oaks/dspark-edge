import { NextResponse } from "next/server";
import { processManager } from "@/lib/process-manager";
import { saveConfig } from "@/lib/config-store";
import type { DashboardConfig } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ status: processManager.allStatus() });
}

interface ActionBody {
  action:
    | "start-server"
    | "stop-server"
    | "start-daemon"
    | "stop-daemon"
    | "quickstart"
    | "stop-all";
  config: DashboardConfig;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST(req: Request) {
  const { action, config } = (await req.json()) as ActionBody;
  if (config) saveConfig(config);

  try {
    switch (action) {
      case "start-server":
        processManager.startServer(config.server);
        break;
      case "stop-server":
        await processManager.stop("server");
        break;
      case "start-daemon":
        processManager.startDaemon(config.daemon);
        break;
      case "stop-daemon":
        await processManager.stop("daemon");
        break;
      case "quickstart":
        // Daemon must be up before the server handshakes over gRPC.
        processManager.startDaemon(config.daemon);
        await sleep(1200);
        processManager.startServer(config.server);
        break;
      case "stop-all":
        await Promise.all([
          processManager.stop("server"),
          processManager.stop("daemon"),
        ]);
        break;
      default:
        return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message, status: processManager.allStatus() },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, status: processManager.allStatus() });
}
