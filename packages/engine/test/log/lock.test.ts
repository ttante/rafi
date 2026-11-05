// The file lock's two check-then-act windows (M5 plan 10.8, part 4a-2 follow-up), each forced deterministically
// with an fs hook rather than timing:
//   release: while the holder lets go, another taker must not get in, and the holder must not delete the new lock;
//   break: two takers that both saw the same dead holder; the second must not delete the lock the first then took.
// Each taker has its own instance; a waiting taker's sleep blocks on a gate the test opens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { withFileLock } from "../../src/log/lock.js";
import type { Deps, Fs } from "../../src/deps/types.js";
import { realFs } from "../../src/deps/real/fs.js";
import { tempDir } from "../helpers.js";

type Hook = (op: string, file: string) => Promise<void> | void;
type Hooks = { fn: Hook | null; after?: (() => void) | null };

function taker(instance: string, o: { hook: Hooks; dead: Set<string>; onWait: () => void;
  gate: { open: Promise<void> } }): Pick<Deps, "fs" | "clock" | "processes" | "random"> {
  let n = 0;
  const random = { id: () => `${instance}-${++n}`, jitter: () => 0 };
  const real = realFs(random);
  const hooked = <K extends keyof Fs>(op: K) => (async (...args: unknown[]) => {
    const fn = o.hook.fn;
    await fn?.(op, String(args[0]));
    const after = fn && !o.hook.fn ? o.hook.after : null;
    try { return await (real[op] as (...a: unknown[]) => Promise<unknown>)(...args); } finally { after?.(); }
  }) as Fs[K];
  return {
    fs: { ...real, rename: hooked("rename"), remove: hooked("remove") }, random,
    clock: { now: () => new Date(0), timer: () => () => undefined,
      sleep: async () => { o.onWait(); await o.gate.open; } },
    processes: { self: () => ({ instance, host: "h", pid: 1, startedAt: null }),
      isAlive: async (owner: { instance: string }) => !o.dead.has(owner.instance) },
  } as unknown as Pick<Deps, "fs" | "clock" | "processes" | "random">;
}

/** Whether the lock folder holds a holder record naming this instance. */
async function holds(fs: Fs, dir: string, instance: string): Promise<boolean> {
  if (!(await fs.stat(dir))) return false;
  for (const f of await fs.list(dir)) {
    try { if ((JSON.parse(await fs.read(path.join(dir, f))) as { instance?: string }).instance === instance) return true; }
    catch { /* not a holder record */ }
  }
  return false;
}

function world() {
  const project = tempDir();
  const dir = path.join(project, ".rafi", "locks", "x");
  const hook: Hooks = { fn: null };
  let open = () => undefined as void;
  const gate = { open: new Promise<void>((r) => { open = r; }) };
  const waits: string[] = [];
  const dead = new Set<string>();
  const make = (instance: string) => taker(instance, { hook, dead, gate, onWait: () => waits.push(instance) });
  return { project, dir, hook, gate, open: () => open(), waits, dead, make };
}

test("release: a taker that tries while the holder lets go waits, and the holder never deletes its lock", async () => {
  const w = world();
  const a = w.make("a");
  const b = w.make("b");
  let releasing = false;
  let bStarted: Promise<unknown> | null = null;
  let aDone = () => undefined as void;
  const aFinished = new Promise<void>((r) => { aDone = r; });
  const seen: string[] = [];
  w.hook.fn = async (op, file) => {
    if (!releasing || bStarted || !file.startsWith(w.dir)) return;
    // A real recursive remove deletes the folder's files first and the folder last; this is that moment.
    if (op === "remove" && file === w.dir) {
      for (const f of readdirSync(w.dir)) rmSync(path.join(w.dir, f), { force: true, recursive: true });
    }
    bStarted = withFileLock(b, w.project, "x", async () => {
      seen.push("b-in");
      await aFinished;
      seen.push(await holds(b.fs, w.dir, "b") ? "b-holds" : "b-lost-its-lock");
    });
    await new Promise<void>((resolve) => {
      const tick = () => (w.waits.includes("b") || seen.includes("b-in") ? resolve() : setImmediate(tick));
      tick();
    });
  };
  const first = await withFileLock(a, w.project, "x", async () => { seen.push("a-in"); releasing = true; });
  aDone();
  w.open();
  assert.ok(first.ok);
  assert.ok(bStarted, "the second taker ran during the release");
  assert.ok((await bStarted!) as { ok: boolean });
  assert.deepEqual(seen, ["a-in", "b-in", "b-holds"]);
  assert.deepEqual(w.waits, ["b"], "the second taker waited for the release");
});

test("break: two takers saw the same dead holder; the one that's second never deletes the lock the first took",
  async () => {
    const w = world();
    const dead = w.make("dead");
    w.dead.add("dead");
    const backup = path.join(w.project, "dead-lock");
    await withFileLock(dead, w.project, "x", async () => { cpSync(w.dir, backup, { recursive: true }); });
    cpSync(backup, w.dir, { recursive: true });
    const a = w.make("a");
    const b = w.make("b");
    const seen: string[] = [];
    let bRun: Promise<unknown> | null = null;
    let aMoved = () => undefined as void;
    const aActed = new Promise<void>((r) => { aMoved = r; });
    w.hook.fn = async (op, file) => {
      if (bRun || !file.startsWith(w.dir) || !(await holds(a.fs, w.dir, "dead"))) return;
      w.hook.fn = null;
      // A is about to act on the dead holder's lock; B breaks it and takes the lock first.
      bRun = withFileLock(b, w.project, "x", async () => {
        seen.push("b-in");
        await aActed;
        seen.push(await holds(b.fs, w.dir, "b") ? "b-holds" : "b-lost-its-lock");
      });
      await new Promise<void>((resolve) => { const tick = () => (seen.includes("b-in") ? resolve()
        : setImmediate(tick)); tick(); });
      void op;
      w.hook.after = () => aMoved();
    };
    const aRun = withFileLock(a, w.project, "x", async () => { seen.push("a-in"); });
    await aActed;
    await new Promise((r) => setTimeout(r, 20));
    w.open();
    await aRun;
    await bRun;
    assert.deepEqual(seen.slice(0, 2), ["b-in", "b-holds"], JSON.stringify(seen));
    assert.equal(seen.indexOf("a-in"), 2, "A got the lock only after B let go");
  });
