// Milestone: M5
// M5 race rows R5 and R6 (plan 3.4; C224, C225): two rafi commands on a fresh clone read the same committed
// `.rafi/progress.yaml`. R5: the clone import is decided inside the append's transaction (the log hasn't moved since
// the entries were chosen), so a writer whose write waited while another imported decides again and imports nothing
// twice. R6: a conflicted file is merged and written back clean inside the progress file's lock and read again
// there, so two writers merging at once write one clean file and say what they kept once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import type { EventsExport } from "../checks/invariants.js";
import { tempRoot } from "../fixtures/common.js";
import { fChain } from "../fixtures/f-chain.js";
import { newComputer, rafiRunner, type LiveRafi, type RafiResult } from "../harness/rafi.js";

const side = (tickets: Record<string, unknown>) =>
  stringify({ version: 1, tickets, questions: {}, answers: {} }, { sortMapEntries: true });

function clone(text: string) {
  const root = tempRoot();
  const dir = fChain(path.join(root, "clone"));
  mkdirSync(path.join(dir, ".rafi"), { recursive: true });
  writeFileSync(path.join(dir, ".rafi", "progress.yaml"), text);
  const computer = newComputer(root);
  return { dir, computer, rafi: rafiRunner(computer, dir) };
}

async function importedKeys(rafi: ReturnType<typeof rafiRunner>): Promise<string[]> {
  const events = (JSON.parse((await rafi("stats export")).out) as EventsExport).events;
  return events.filter((e) => e.type === "progress.imported")
    .map((e) => (e.data as { entry: { key: string } }).entry.key).sort();
}

test("R5: two writers on a fresh clone; the second imports while the first's write waits; each entry once",
  async () => {
    const c = clone(side({ T1: { status: "done", at: "2026-11-01T13:00:00Z" },
      T4: { status: "blocked", at: "2026-11-01T13:00:00Z", reason: "waiting on a key" } }));
    let second: RafiResult | null = null;
    c.computer.clock.whenTimer("backoff", async () => {
      if (second) return;
      second = await c.rafi("start . --steps 1");
    });
    // The first start's second BEGIN (after the log's own open) is the import's append, before the project's
    // adoption (C224): it's busy once. Mutation `race-5` shows the interleaving lands there.
    const first = await c.rafi("start . --steps 1", { faults: { busyAt: 2 } });
    assert.ok(second, "the second writer ran while the first's import waited");
    const two = second as RafiResult;
    assert.equal(two.code, 0, two.output);
    assert.equal(first.code, 0, first.output);
    assert.match(two.output, /Rebuilt build state from \.rafi\/progress\.yaml\./);
    assert.doesNotMatch(first.output, /Rebuilt build state/, "the first decided again and had nothing to import");
    assert.deepEqual(await importedKeys(c.rafi), ["T1", "T4"], "each entry imported once");
  });

test("R6: two writers merge the same conflicted file at once: one clean file, one set of lines", async () => {
  const ours = side({ T1: { status: "done", at: "2026-11-01T13:10:00Z" } });
  const theirs = side({ T1: { status: "planned", at: "1970-01-01T00:00:00.000Z" },
    T3: { status: "done", at: "2026-11-01T13:20:00Z" } });
  const c = clone(`<<<<<<< HEAD\n${ours}=======\n${theirs}>>>>>>> clone-2\n`);
  const lock = path.join(c.dir, ".rafi", "locks", "progress.yaml");
  let second: LiveRafi | null = null;
  const first = await c.rafi("start . --steps 1", { onRead: async (file) => {
    // Inside the first writer's lock, before it reads the file again: the second writer reads the conflicted
    // file and waits on the lock.
    if (second || !file.endsWith("progress.yaml") || !existsSync(lock)) return;
    const waiting = new Promise<void>((resolve) => c.computer.clock.whenTimer("backoff", resolve));
    second = c.rafi.start("start . --steps 1");
    await waiting;
  } });
  assert.ok(second, "the second writer started while the first held the lock");
  const two = await (second as LiveRafi).done();
  assert.equal(first.code, 0, first.output);
  assert.equal(two.code, 0, two.output);
  const kept = `${first.output}\n${two.output}`.split("\n").filter((l) => /^(rafi: )?T\d: kept /.test(l));
  assert.deepEqual(kept.map((l) => l.replace(/^rafi: /, "")).sort(),
    ["T1: kept ours (13:10 vs 00:00)"],
    `one set of lines:\n${first.output}\n---\n${two.output}`);
  assert.doesNotMatch(readFileSync(path.join(c.dir, ".rafi", "progress.yaml"), "utf8"), /^(<{7}|={7}|>{7})/m);
  assert.deepEqual(await importedKeys(c.rafi), ["T1", "T3"], "each entry imported once");
});
