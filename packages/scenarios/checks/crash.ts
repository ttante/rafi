// The crash enumeration driver (SCN 7.7, S-CRASH-1; P33, C163, C160). One clean run in record mode takes a snapshot
// at each chosen point; each point is restored and `rafi resume`d until the build finishes (at most 3 times), and
// `checkCrashRun` plus the files check run on it. A few points also run literally: a fresh fixture, `crashAt(k)`,
// the fence, then the same resumes.
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { Rule } from "../fakes/script/engine.js";
import { git, tempRoot } from "../fixtures/common.js";
import { restore, takeSnapshot, type Snapshot } from "../harness/fork.js";
import { newComputer, rafiRunner, type Rafi } from "../harness/rafi.js";
import type { Computer } from "../harness/deps.js";
import assert from "node:assert/strict";
import { checkCrashRun, type EventsExport } from "./invariants.js";

export interface CrashCase {
  readonly fixture: (root: string) => string;
  readonly script: () => Rule[];
  readonly line: string;
  /** SCN 7.10's lever: which clean-run occurrences become fork points (called in order, so it can keep state). */
  readonly points: (occurrence: string, index: number) => boolean;
  /** Points run literally with crashAt (names or 1-based indexes). */
  readonly literal?: readonly (string | number)[];
  /** M5 (C321): after the clean run, which of the snapshots taken stay fork points ("the first and last of T2"). */
  readonly pick?: (occurrences: readonly string[]) => readonly string[];
  /** Run on every computer before its first command (the clean run's, each point's, each literal one's): a merge
   * wait's polls, a fake provider's settings. */
  readonly setup?: (computer: Computer) => void;
  /** More checks on a resumed point's project against the clean run (M5's git checks, C322). */
  readonly extra?: (o: { project: string; final: EventsExport; clean: EventsExport; computer: Computer;
    cleanComputer: Computer; cleanProject: string }) => string[];
}

export interface CrashReport {
  readonly clean: readonly string[];
  readonly forked: readonly string[];
  readonly literal: readonly string[];
  readonly problems: readonly string[];
}

/** Every file outside `.git/` and `.rafi/`, with its content; a worktree's `.git` file (which names its repository by
 * path, so a copy's differs) and its `.rafi/cache/` (rafi's local caches, never committed) are left out too. */
export function workFiles(dir: string, base = dir, out: Record<string, string> = {}): Record<string, string> {
  for (const name of readdirSync(dir).sort()) {
    if (name === ".git" || (dir === base && name === ".rafi")) continue;
    if (name === "cache" && path.basename(dir) === ".rafi") continue;
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

interface Clean { e: EventsExport; files: object; computer: Computer; project: string }

async function check(c: CrashCase, name: string, at: { rafi: Rafi; project: string; computer: Computer },
  clean: Clean): Promise<string[]> {
  const beforeResume = await exportOf(at.rafi);
  const { outputs, final } = await resumeUntilDone(at.rafi);
  const problems = checkCrashRun({ beforeResume, final, clean: clean.e, resumeOutput: outputs });
  if (!finished(final)) problems.push("the build didn't finish after 3 resumes");
  if (JSON.stringify(workFiles(at.project)) !== JSON.stringify(clean.files)) problems.push("the files differ");
  problems.push(...(c.extra?.({ project: at.project, final, clean: clean.e, computer: at.computer,
    cleanComputer: clean.computer, cleanProject: clean.project }) ?? []));
  return problems.map((p) => `${name}: ${p}`);
}

export async function enumerateCrashes(c: CrashCase): Promise<CrashReport> {
  const root = tempRoot();
  const project = c.fixture(root);
  const computer: Computer = newComputer(root);
  computer.script.rules.push(...c.script());
  c.setup?.(computer);
  let snaps: Snapshot[] = [];
  const into = tempRoot("rafi-snap-");
  const rafi = rafiRunner(computer, project);
  const run = await rafi(c.line, { onEach: (occurrence, index) => {
    if (c.points(occurrence, index)) snaps.push(takeSnapshot(computer, project, into, occurrence, index));
  } });
  const clean: Clean = { e: await exportOf(rafi), files: workFiles(project), computer, project };
  if (c.pick) {
    const keep = new Set(c.pick(snaps.map((s) => s.occurrence)));
    snaps = snaps.filter((s) => keep.has(s.occurrence));
  }
  const problems = run.code === 0 ? [] : [`the clean run exited ${run.code}: ${run.output.slice(-400)}`];
  const literal: string[] = [];
  // Each point has its own computer, clock and folders, so they run side by side: a resume mostly waits on git.
  const jobs = [...snaps.map((snap) => async () => {
    const restored = restore(snap);
    c.setup?.(restored.computer);
    return check(c, snap.occurrence, { rafi: rafiRunner(restored.computer, restored.project), ...restored }, clean);
  }), ...(c.literal ?? []).map((at) => async () => {
    const r = tempRoot();
    const dir = c.fixture(r);
    const other = newComputer(r);
    other.script.rules.push(...c.script());
    c.setup?.(other);
    const literalRafi = rafiRunner(other, dir);
    const crashed = await literalRafi(c.line, { crashAt: at });
    if (!crashed.crashed) return [`literal ${String(at)}: never reached`];
    literal.push(crashed.crashed);
    return check(c, `literal ${crashed.crashed}`, { rafi: literalRafi, project: dir, computer: other }, clean);
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

const RESULTS: Record<string, readonly string[]> = { branch: ["git.branch_created"], commit: ["git.committed"],
  push: ["git.pushed"], "pr-create": ["pr.created"], "pr-ready": ["unit.delivered", "unit.merge_waiting", "pr.merged"],
  "auto-merge": ["unit.delivered", "unit.merge_waiting", "pr.merged"], merge: ["unit.delivered"] };
type Ev = EventsExport["events"][number];

/** C235 (P51): an intent is followed by its own result, recorded then or reconciled on a redo. */
function answered(i: Ev, later: readonly Ev[]): boolean {
  const d = i.data as { op: string; unit: string | null; ticket: string | null; ref: string | null;
    new: string | null };
  const branch = d.ref?.replace(/^refs\/heads\//, "") ?? null;
  return later.some((e) => {
    if (!RESULTS[d.op]?.includes(e.type) && !(d.op === "commit" && !d.ticket && e.type === "git.pushed")) return false;
    const r = e.data as { branch?: string | null; unit?: string | null; sha?: string | null };
    if (d.op === "branch") return r.branch === branch;
    if (d.op === "commit") return d.ticket ? e.ticket_id === d.ticket : r.branch === branch;
    if (d.op === "push") return r.branch === branch && r.sha === d.new;
    if (d.op === "pr-create") return r.branch === branch;
    return r.unit === d.unit;
  });
}

const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean).sort();
/** Each branch with its commit count (a doubled commit or merge shows; shas differ by commit time). */
const refsOf = (dir: string) => existsSync(dir) ? lines(git(dir, ["for-each-ref", "--format=%(refname)",
  "refs/heads"])).map((ref) => `${ref}:${git(dir, ["rev-list", "--count", ref]).trim()}`) : [];

/**
 * M5's git checks at a resumed point (ARCH 14.1, P45; C322): one commit per ticket (by its trailer, over every
 * ref), one PR per branch and the clean run's PRs, the clean run's local and remote branches with as many commits
 * each (so no push of any other ref, no doubled merge), and every `git.intent` followed by its result.
 */
export function gitChecks(o: Parameters<NonNullable<CrashCase["extra"]>>[0]): string[] {
  const problems: string[] = [];
  const committed = new Set(o.clean.events.filter((e) => e.type === "git.committed").map((e) => e.ticket_id!));
  for (const id of committed) {
    const shas = lines(git(o.project, ["log", "--all", "--format=%H", `--grep=^Rafi-Ticket: ${id}$`]));
    if (shas.length !== 1) problems.push(`${shas.length} commits carry Rafi-Ticket: ${id}`);
  }
  const heads = (prs: readonly { head: string }[]) => prs.map((p) => p.head).sort();
  const mine = heads(o.computer.gh.prs);
  if (new Set(mine).size !== mine.length) problems.push(`more than one PR for a branch: ${mine.join(", ")}`);
  if (JSON.stringify(mine) !== JSON.stringify(heads(o.cleanComputer.gh.prs))) problems.push(`PRs ${mine.join(", ")}`);
  if (JSON.stringify(refsOf(o.project)) !== JSON.stringify(refsOf(o.cleanProject))) {
    problems.push(`branches ${refsOf(o.project).join(", ")}`);
  }
  const remote = (p: string) => refsOf(path.join(path.dirname(p), "remote.git"));
  if (JSON.stringify(remote(o.project)) !== JSON.stringify(remote(o.cleanProject))) {
    problems.push(`remote branches ${remote(o.project).join(", ")}`);
  }
  o.final.events.forEach((e, at) => {
    if (e.type === "git.intent" && !answered(e, o.final.events.slice(at + 1))) {
      problems.push(`git.intent ${JSON.stringify(e.data)} has no result`);
    }
  });
  return problems;
}

/** An M5 git enumeration: the case with gitChecks; at least `least` points crashed; no problem anywhere. */
export async function holds(name: string, c: CrashCase, least: number): Promise<CrashReport> {
  const report = await enumerateCrashes({ ...c, extra: gitChecks });
  if (process.env.RAFI_SHOW_POINTS) console.log(name, JSON.stringify(report, null, 1));
  assert.ok(report.forked.length + report.literal.length >= least, `${name}: ${report.clean.join("\n")}`);
  assert.deepEqual(report.problems, [], `${name}: ${report.forked.length} forked: ${report.forked.join(" | ")}`);
  return report;
}
