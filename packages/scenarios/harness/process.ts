// Process mode (SCN 7.2 `next-process`, plan choice C25): spawns the built launcher,
// `node packages/rafi/dist/launcher.js`, with fakes first on PATH and RAFI_ENGINE as the step says.
// Refuses to run when dist/ is older than the launcher or src/next.
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { shellEnv } from "./shell-env.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const LAUNCHER = path.join(repo, "packages", "rafi", "dist", "launcher.js");

function newest(dir: string): number {
  let latest = 0;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const info = statSync(full);
    latest = Math.max(latest, info.isDirectory() ? newest(full) : info.mtimeMs);
  }
  return latest;
}

export function assertFreshBuild(): void {
  const src = path.join(repo, "packages", "rafi", "src");
  const built = statSync(LAUNCHER, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  const source = Math.max(statSync(path.join(src, "launcher.ts")).mtimeMs, newest(path.join(src, "next")),
    newest(path.join(repo, "packages", "engine", "src")));
  if (built < source) throw new Error("packages/rafi/dist is older than its source; run `pnpm test:process`");
}

/** The built engine (packages/engine/dist), refusing a dist/ older than packages/engine/src. */
export async function builtEngine<T>(subpath: string): Promise<T> {
  const engine = path.join(repo, "packages", "engine");
  const file = path.join(engine, "dist", subpath, "index.js");
  const built = statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  if (built < newest(path.join(engine, "src"))) {
    throw new Error("packages/engine/dist is older than its source; run `pnpm test:process`");
  }
  return (await import(pathToFileURL(file).href)) as T;
}

export interface ProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Runs the built launcher once. `engine: "next"` sets RAFI_ENGINE=next; otherwise it's removed. */
export function launcher(args: string[], o: { cwd: string; engine?: "next"; pathFirst?: string;
  env?: Record<string, string>; timeoutMs?: number }): ProcessResult {
  assertFreshBuild();
  const env: Record<string, string | undefined> = { ...shellEnv(), TZ: "UTC", ...o.env };
  delete env.RAFI_ENGINE;
  if (o.engine) env.RAFI_ENGINE = o.engine;
  if (o.pathFirst) env.PATH = `${o.pathFirst}${path.delimiter}${env.PATH ?? ""}`;
  const result = spawnSync(process.execPath, [LAUNCHER, ...args], { cwd: o.cwd, env, encoding: "utf8",
    timeout: o.timeoutMs ?? 180_000 });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", env };
}
