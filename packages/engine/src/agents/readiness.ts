// Finding the agent CLIs (NEW-ADP-4): the absolute `codex` or `claude` on PATH, through deps.fs. Versions and
// login are `rafi doctor`'s (M10); a CLI that isn't found keeps its bare name and fails at spawn.
import path from "node:path";
import type { Env, Fs } from "../deps/types.js";

export async function findOnPath(fs: Fs, env: Env, name: string): Promise<string | null> {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const file = path.join(dir, name);
    if ((await fs.stat(file))?.kind === "file") return file;
  }
  return null;
}
