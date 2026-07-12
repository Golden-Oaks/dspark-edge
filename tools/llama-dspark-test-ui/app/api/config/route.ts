import { NextResponse } from "next/server";
import { loadConfig, saveConfig, PRESETS } from "@/lib/config-store";
import {
  buildDir,
  defaultDaemonBin,
  defaultServerBin,
  exists,
  modelsDir,
  repoRoot,
} from "@/lib/paths";
import type { DashboardConfig } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  const config = loadConfig();
  return NextResponse.json({
    config,
    presets: PRESETS,
    paths: {
      repoRoot: repoRoot(),
      buildDir: buildDir(),
      modelsDir: modelsDir(),
      serverBin: defaultServerBin(),
      daemonBin: defaultDaemonBin(),
      serverBinExists: exists(defaultServerBin()),
      daemonBinExists: exists(defaultDaemonBin()),
    },
  });
}

export async function POST(req: Request) {
  const body = (await req.json()) as DashboardConfig;
  saveConfig(body);
  return NextResponse.json({ ok: true, config: body });
}
