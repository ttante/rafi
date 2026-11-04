// Process set, M4 item 14: S-ENG-7's start / Ctrl+C / resume cycles, on both fake executables. 20 cycles in a real
// PTY (`rafi start` once, then `rafi resume`), each pressing Ctrl+C once a turn is in flight, then a final
// `rafi resume` to the end. After the 20th: no provider process from an earlier rafi is left; while the final build
// runs, only it and its own children hold project files open (lsof, skipped where missing), and nothing does after
// it; checkCrashRun's invariants hold against a clean run; the build finishes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { checkCrashRun, type EventsExport } from "../checks/invariants.js";
import { pOn, writeShims } from "../fakes/shims.js";
import { configure, tempRoot } from "../fixtures/common.js";
import { fChain3 } from "../fixtures/f-chain3.js";
import { alive, launch, ops, processes, providerPids, run, waitFor } from "../harness/process-run.js";

const CYCLES = 20;
const CTRL_C = "\u0003";

function setup(runtime: "codex" | "claude", slow: number) {
  const root = tempRoot("rafi-cycles-");
  const project = fChain3(root);
  configure(project, { harness: { targets: [runtime] } });
  // One slow builder turn per cycle (each is used once); the final resume gets the happy path.
  const rules = Array.from({ length: slow }, () => pOn("builder T1 @build", { kind: "slow", ms: 30_000, every: 250 }));
  const shims = writeShims(root, { rules });
  return { project, log: shims.logs[runtime], o: { cwd: project, pathFirst: shims.bin } };
}

const exported = async (o: { cwd: string; pathFirst: string }) =>
  JSON.parse((await run(["stats", "export"], o)).output) as EventsExport;
const lsofAvailable = spawnSync("lsof", ["-v"], { encoding: "utf8" }).error === undefined;

/** Processes holding files under `dir` open (lsof +D: pid, parent pid, command, file), or null without lsof. */
function holders(dir: string): { pid: number; ppid: number; command: string; file: string }[] | null {
  if (!lsofAvailable) return null;
  const out = spawnSync("lsof", ["-F", "pRcn", "+D", dir], { encoding: "utf8" }).stdout ?? "";
  const rows: { pid: number; ppid: number; command: string; file: string }[] = [];
  let cur = { pid: 0, ppid: 0, command: "" };
  for (const line of out.split("\n").filter(Boolean)) {
    const [tag, value] = [line[0], line.slice(1)];
    if (tag === "p") cur = { pid: Number(value), ppid: 0, command: "" };
    if (tag === "R") cur.ppid = Number(value);
    if (tag === "c") cur.command = value;
    if (tag === "n") rows.push({ ...cur, file: value });
  }
  return rows;
}

/** `pid` and every process descended from it. */
function family(pid: number): Set<number> {
  const rows = processes();
  const out = new Set([pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const r of rows) if (out.has(r.ppid) && !out.has(r.pid)) { out.add(r.pid); grew = true; }
  }
  return out;
}

/** Turn attempts (turn.intent by key and attempt) sent more than once under one owner. */
function oncePerOwner(e: EventsExport): string[] {
  let owner = 0;
  const seen = new Set<string>();
  const twice: string[] = [];
  for (const x of e.events) {
    if (x.type === "build.owner_acquired") owner += 1;
    if (x.type !== "turn.intent") continue;
    const d = x.data as { key: string; attempt: number };
    const id = `${owner}|${d.key}|${d.attempt}`;
    if (seen.has(id)) twice.push(`${d.key} attempt ${d.attempt} twice under owner ${owner}`);
    seen.add(id);
  }
  return twice;
}

for (const runtime of ["codex", "claude"] as const) {
  test(`S-ENG-7 cycles (process, ${runtime}): 20 start / Ctrl+C / resume cycles, then the build finishes`,
    { skip: process.platform === "win32" ? "a PTY, ps and lsof need POSIX" : false, timeout: 600_000 }, async () => {
      const clean = setup(runtime, 0);
      assert.equal((await run(["start", ".", "--steps", "3"], clean.o)).code, 0);
      const cleanExport = await exported(clean.o);
      const s = setup(runtime, CYCLES);
      const outputs: string[] = [];
      const builds = () => ops(s.log).filter((o) => o.op === "pick" &&
        (o.identity as { step?: string } | null)?.step === "build").length;
      for (let i = 0; i < CYCLES; i += 1) {
        const before = builds();
        const live = launch(i === 0 ? ["start", ".", "--steps", "3"] : ["resume"], { ...s.o, pty: true });
        await waitFor(`cycle ${i + 1}'s turn in flight`, () => builds() > before, 60_000);
        await new Promise((r) => setTimeout(r, 300));
        live.type(CTRL_C);
        const r = await live.done;
        outputs.push(r.output);
        assert.equal(r.code, 130, `cycle ${i + 1}: ${r.output.slice(-800)}`);
      }
      const earlier = providerPids(s.log);
      await waitFor("no provider from an earlier rafi", () => earlier.every((p) => !alive(p)), 10_000);
      const beforeResume = await exported(s.o);
      const final = launch(["resume"], s.o);
      await waitFor("the final build's first turn", () => providerPids(s.log).length > earlier.length, 60_000);
      const during = holders(s.project);
      if (during) {
        const mine = family(final.pid);
        const strangers = during.filter((h) => !mine.has(h.pid) && !mine.has(h.ppid));
        assert.deepEqual(strangers, [], "only the current build and its children hold project files open");
      }
      const done = await final.done;
      outputs.push(done.output);
      assert.equal(done.code, 0, done.output.slice(-1500));
      assert.deepEqual(holders(s.project) ?? [], [], "nothing holds a project file open after the build");
      const after = await exported(s.o);
      assert.ok(after.events.some((x) => x.type === "build.finished"), "the build finished on the final resume");
      // S-CRASH-1's checker, with its turn count read per owner: a turn interrupted in each of 20 cycles is redone
      // once in each, so "once before and once after" (one crash) becomes "at most once per owner" (21 of them).
      const problems = checkCrashRun({ beforeResume, final: after, clean: cleanExport, resumeOutput: outputs });
      assert.deepEqual(problems.filter((p) => !/^turn \S+ ran \d+ times before/.test(p)), []);
      assert.deepEqual(oncePerOwner(after), [], "each turn attempt at most once per owner");
    });
}
