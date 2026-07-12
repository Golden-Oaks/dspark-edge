import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { modelsDir } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ModelEntry {
  name: string;
  path: string;
  sizeBytes: number;
}

function walk(dir: string, depth = 2): ModelEntry[] {
  const out: ModelEntry[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) {
      out.push(...walk(full, depth - 1));
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".gguf")) {
      let sizeBytes = 0;
      try {
        sizeBytes = fs.statSync(full).size;
      } catch {
        /* ignore */
      }
      out.push({ name: e.name, path: full, sizeBytes });
    }
  }
  return out;
}

export function GET(req: Request) {
  const url = new URL(req.url);
  const dir = url.searchParams.get("dir") || modelsDir();
  const models = walk(dir).sort((a, b) => a.name.localeCompare(b.name));
  return NextResponse.json({ dir, models });
}
