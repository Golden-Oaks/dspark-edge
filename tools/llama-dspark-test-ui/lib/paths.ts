import path from "node:path";
import fs from "node:fs";

/**
 * Resolve the dspark-edging repo root. The dashboard normally runs from
 * `<repo>/tools/llama-dspark-test-ui`, so the repo root is two levels up.
 * Override with DSPARK_REPO_ROOT when running from elsewhere.
 */
export function repoRoot(): string {
  const override = process.env.DSPARK_REPO_ROOT;
  if (override) return path.resolve(override);
  // process.cwd() is the app dir during `next dev`.
  return path.resolve(process.cwd(), "..", "..");
}

export function buildDir(): string {
  return process.env.DSPARK_BUILD_DIR
    ? path.resolve(process.env.DSPARK_BUILD_DIR)
    : path.join(repoRoot(), "build");
}

export function modelsDir(): string {
  return process.env.DSPARK_MODELS_DIR
    ? path.resolve(process.env.DSPARK_MODELS_DIR)
    : path.join(repoRoot(), "models");
}

export function defaultServerBin(): string {
  return path.join(buildDir(), "bin", "llama-server");
}

export function defaultDaemonBin(): string {
  return path.join(buildDir(), "tools", "llama-dspark-grpcd", "llama-dspark-grpcd");
}

export function configFilePath(): string {
  return path.join(process.cwd(), ".dashboard-config.json");
}

export function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}
