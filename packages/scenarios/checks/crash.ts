// The crash enumeration driver (SCN 7.7, S-CRASH-1; P33, C163, C160). One clean run in record mode takes a snapshot
// at each chosen point; each point is restored and `rafi resume`d until the build finishes (at most 3 times), and
// `checkCrashRun` plus the files check run on it. A few points also run literally: a fresh fixture, `crashAt(k)`,
// the fence, then the same resumes.
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { Rule } from "../fakes/script/engine.js";
import { tempRoot } from "../fixtures/common.js";
import { restore, takeSnapshot, type Snapshot } from "../harness/fork.js";
import { newComputer, rafiRunner, type Rafi } from "../harness/rafi.js";
import type { Computer } from "../harness/deps.js";
import { checkCrashRun, type EventsExport } from "./invariants.js";

export interface CrashCase {
  readonly fixture: (root: string) => string;
  readonly script: () => Rule[];
  readonly line: string;
  /** SCN 7.10's lever: which clean-run occurrences become fork points (called in order, so it can keep state). */
  readonly points: (occurrence: string, index: number) => boolean;
  /** Points run literally with crashAt (names or 1-based indexes). */
  readonly literal?: readonly (string | number)[];
}

export interface CrashReport {
  readonly clean: readonly string[];
  readonly forked: readonly string[];
  readonly literal: readonly string[];
  readonly problems: readonly string[];
}

/** Every file outside `.git/` and `.rafi/`, with its content. */
export function workFiles(dir: string, base = dir, out: Record<string, string> = {}): Record<string, string> {
  for (const name of readdirSync(dir).sort()) {
    if (dir === base && (name === ".git" || name === ".rafi")) continue;
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) workFiles(file, base, out);
    else out[path.relative(base, file)] = readFileSync(file, "utf8");
  }
  return out;
}

const exportOf = async (rafi: Rafi) => JSON.parse((await rafi("stats export")).out) as EventsExport;
const finished = (e: EventsExport) => e.events.filter((x) => x.type.startsWith("build.")).at(-1)?.type ===
  "build.owner_released" && e.events.some((x) => x.type === "build.finished");

async function resumeUntilDone(rafi: Rafi): Promise<{ outputs: string[]; final: EventsExport }> {
  const outputs: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const r = await rafi("resume");
    outputs.push(r.output);
    if (finished(await exportOf(rafi))) break;
  }
  return { outputs, final: await exportOf(rafi) };
}

async function check(name: string, rafi: Rafi, project: string, clean: { e: EventsExport; files: object }):
  Promise<string[]> {
  const beforeResume = await exportOf(rafi);
  const { outputs, final } = await resumeUntilDone(rafi);
  const problems = checkCrashRun({ beforeResume, final, clean: clean.e, resumeOutput: outputs });
  if (!finished(final)) problems.push("the build didn't finish after 3 resumes");
  if (JSON.stringify(workFiles(project)) !== JSON.stringify(clean.files)) problems.push("the files differ");
  return problems.map((p) => `${name}: ${p}`);
}

export async function enumerateCrashes(c: CrashCase): Promise<CrashReport> {
  const root = tempRoot();
  const project = c.fixture(root);
  const computer: Computer = newComputer(root);
  computer.script.rules.push(...c.script());
  const snaps: Snapshot[] = [];
  const into = tempRoot("rafi-snap-");
  const rafi = rafiRunner(computer, project);
  const run = await rafi(c.line, { onEach: (occurrence, index) => {
    if (c.points(occurrence, index)) snaps.push(takeSnapshot(computer, project, into, occurrence, index));
  } });
  const clean = { e: await exportOf(rafi), files: workFiles(project) };
  const problems = run.code === 0 ? [] : [`the clean run exited ${run.code}: ${run.output.slice(-400)}`];
  const literal: string[] = [];
  // Each point has its own computer, clock and folders, so they run side by side: a resume mostly waits on git.
  const jobs = [...snaps.map((snap) => async () => {
    const restored = restore(snap);
    return check(snap.occurrence, rafiRunner(restored.computer, restored.project), restored.project, clean);
  }), ...(c.literal ?? []).map((at) => async () => {
    const r = tempRoot();
    const dir = c.fixture(r);
    const other = newComputer(r);
    other.script.rules.push(...c.script());
    const literalRafi = rafiRunner(other, dir);
    const crashed = await literalRafi(c.line, { crashAt: at });
    if (!crashed.crashed) return [`literal ${String(at)}: never reached`];
    literal.push(crashed.crashed);
    return check(`literal ${crashed.crashed}`, literalRafi, dir, clean);
  })];
  for (const found of await pool(jobs, PARALLEL)) problems.push(...found);
  // The snapshots are copies of the project per point: removed once checked, so runs don't fill the disk.
  if (!problems.length) for (const dir of [into, root]) rmSync(dir, { recursive: true, force: true });
  return { clean: run.passed, forked: snaps.map((s) => s.occurrence), literal, problems };
}

const PARALLEL = 6;

/** Runs the jobs `width` at a time; results in job order. */
async function pool<T>(jobs: readonly (() => Promise<T>)[], width: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await jobs[i]!();
    }
  }));
  return out;
}

/** SCN 7.10's lever for S-CRASH-1: every occurrence while `ticket` is the one being built (unnamed boundaries 5
 * included), and only the step boundaries (4) of the others. */
export function lever(ticket: string, keep: (inTicket: boolean, n: number) => boolean) {
  let inside = false;
  let n = 0;
  return (occurrence: string) => {
    const named = /\((T\d+)/.exec(occurrence)?.[1];
    if (named) inside = named === ticket;
    if (inside) return keep(true, n++);
    return keep(false, -1) && occurrence.startsWith("4:");
  };
}
