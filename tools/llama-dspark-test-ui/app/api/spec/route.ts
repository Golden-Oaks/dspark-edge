import { NextResponse } from "next/server";
import { loadConfig } from "@/lib/config-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function baseUrl(req: Request): string {
  const url = new URL(req.url);
  const override = url.searchParams.get("base");
  if (override) return override.replace(/\/$/, "");
  const cfg = loadConfig();
  const host = cfg.server.host === "0.0.0.0" ? "127.0.0.1" : cfg.server.host;
  return `http://${host}:${cfg.server.httpPort}`;
}

async function tryFetch(url: string, timeoutMs = 2000): Promise<unknown | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function GET(req: Request) {
  const base = baseUrl(req);
  const [spec, health, props] = await Promise.all([
    tryFetch(`${base}/debug/spec`),
    tryFetch(`${base}/health`),
    tryFetch(`${base}/props`),
  ]);
  const reachable = health != null || spec != null || props != null;
  return NextResponse.json({ base, reachable, spec, health, props });
}
