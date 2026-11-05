// Part 6 (M5 review P1, the second): what rafi last wrote to each of its views in your checkout
// (`docs/ticket-progress.md`, `docs/ticket-archive.md`), so rafi drops, resets or rewrites only bytes it wrote. Each
// write records the sha256 of its bytes under `.rafi/cache/views/` (rafi's own, never committed). A view whose bytes
// aren't the recorded ones is yours: the dirty check counts it (PRM-75), a direct merge leaves it alone, a commit
// doesn't carry it, and a safe point doesn't overwrite it while git says it has uncommitted changes.
import { createHash } from "node:crypto";
import path from "node:path";
import type { Engine } from "../api/engine.js";
import type { Fs } from "../deps/types.js";
import { gitTry } from "../git/run.js";

const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** The record of one view, by its path in the project (`docs/ticket-progress.md` → `docs__ticket-progress.md`). */
const markOf = (project: string, file: string) => path.join(project, ".rafi", "cache", "views",
  `${path.relative(project, file).split(/[\\/]/).join("__")}.sha256`);

/** True when `file` exists and holds exactly the bytes rafi last wrote to it. */
export async function rafisView(fs: Fs, project: string, file: string): Promise<boolean> {
  const mark = markOf(project, file);
  if (!(await fs.stat(file)) || !(await fs.stat(mark))) return false;
  return (await fs.read(mark)).trim() === digest(await fs.readBytes(file));
}

/** Writes a view and records its bytes. Unless `force` (`rafi tickets render`), a view that isn't rafi's and that
 * git lists as changed is your edit: left as it is (false). */
export async function writeView(engine: Engine, file: string, text: string, force = false): Promise<boolean> {
  const { fs } = engine.deps;
  const project = engine.projectDir;
  if (!force && (await fs.stat(file)) && !(await rafisView(fs, project, file))) {
    const r = await gitTry({ deps: engine.deps, project }, project, ["status", "--porcelain", "--untracked-files=all",
      "--", path.relative(project, file)]);
    if (r.code === 0 && r.stdout.trim()) return false;
  }
  await fs.mkdir(path.dirname(file));
  await fs.writeAtomic(file, text);
  const mark = markOf(project, file);
  await fs.mkdir(path.dirname(mark));
  await fs.writeAtomic(mark, `${digest(text)}\n`);
  return true;
}
