// Milestone: M5
// M5 P49, plan item 17b (ARCH 3.7 `:413`; C224): an unfinished CI fix ticket survives a clone. Clone 1 runs F-TESTS
// until FIX-1 is added and QA rejects its first build, then crashes in the fix turn; its committed progress file
// carries FIX-1 with `owned`. Clone 2 (no database; the file is all it has, as a fresh clone of that commit) imports
// it in one transaction: `ticket.added` from `owned`, then `progress.imported`; FIX-1 is rafi-owned, first in the
// queue, keeps its fix count, isn't in tickets.yaml, and is built to done; T1–T3 stay done.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import { B, on } from "../fakes/script/behaviors.js";
import { git, tempRoot } from "../fixtures/common.js";
import { fTests } from "../fixtures/f-tests.js";
import { newComputer, rafiRunner } from "../harness/rafi.js";
import type { EventsExport } from "../checks/invariants.js";

test("17b: an unfinished CI fix ticket comes back rafi-owned on a clone, keeps its fixes, and is built to done",
  async () => {
    const root = tempRoot();
    const one = fTests(path.join(root, "one"));
    const computer = newComputer(root);
    const t = computer.checks.tests;
    t["suite/x.test"] = { outcomes: ["pass"], failWhen: { file: "src/T2.txt", contains: "T2 done",
      unless: "src/FIX-1.txt" } };
    computer.script.rules.push(on("qa FIX-1#1 @prepare", B.requirements([{ from: 1, text: "suite/x.test passes",
      check: "fake-test suite/x.test" }])), on("qa FIX-1#1 @review", B.reject({ 1: "still fails for me" })));
    const rafi = rafiRunner(computer, one);
    const crashed = await rafi("start . --steps 3", { crashAt: "2: sent, before any reply (FIX-1, fix" });
    assert.notEqual(crashed.code, 0, crashed.output);
    const file = readFileSync(path.join(one, ".rafi", "progress.yaml"), "utf8");
    const entry = (parse(file) as { tickets: Record<string, Record<string, unknown>> }).tickets["FIX-1"]!;
    assert.deepEqual(entry.owned, { source: "ci", requirements: ["suite/x.test"], hint: "T2", unit: null }, file);
    assert.equal(entry.fixes, 1, file);

    const two = fTests(path.join(root, "two"));
    mkdirSync(path.join(two, ".rafi"), { recursive: true });
    writeFileSync(path.join(two, ".rafi", "progress.yaml"), file);
    git(two, ["add", "-f", ".rafi/progress.yaml"]);
    git(two, ["commit", "-qm", "progress from the other computer"]);
    const r = await rafi("start . --steps 1", { cwd: two });
    assert.equal(r.code, 0, r.output);
    assert.match(r.output, /Rebuilt build state from \.rafi\/progress\.yaml\./);
    const events = (JSON.parse((await rafi("stats export", { cwd: two })).out) as EventsExport).events;
    const at = events.findIndex((e) => e.type === "ticket.added");
    assert.deepEqual([events[at]?.ticket_id, events[at + 1]?.type, events[at + 1]?.ticket_id],
      ["FIX-1", "progress.imported", "FIX-1"], "ticket.added, then its progress.imported, in one append");
    assert.equal(events[at]!.source, "progress-file");
    assert.equal((events[at + 1]!.data as { entry: { fixes?: number } }).entry.fixes, 1, "keeps its fix count");
    const starts = events.filter((e) => e.type === "ticket.started").map((e) => e.ticket_id);
    assert.equal(starts[0], "FIX-1", "first in the queue");
    assert.ok(events.some((e) => e.type === "delivery.done" && e.ticket_id === "FIX-1"), "built to done");
    const after = parse(readFileSync(path.join(two, ".rafi", "progress.yaml"), "utf8")) as
      { tickets: Record<string, { status: string; owned?: unknown }> };
    assert.deepEqual([after.tickets["FIX-1"]?.status, Boolean(after.tickets["FIX-1"]?.owned)], ["done", true]);
    assert.doesNotMatch(readFileSync(path.join(two, ".tickets", "tickets.yaml"), "utf8"), /FIX-1/);
    for (const id of ["T1", "T2", "T3"]) {
      assert.ok(!events.some((e) => e.ticket_id === id && e.type === "ticket.started"), `${id} isn't rebuilt`);
    }
  });

/** One computer's F-TESTS run until its FIX-1 (for `test`, which `ticket` breaks) is rejected once, then killed. */
async function crashedInFix(root: string, name: string, test: string, ticket: string) {
  const dir = fTests(path.join(root, name));
  const computer = newComputer(path.join(root, `${name}-home`));
  computer.checks.tests[test] = { outcomes: ["pass"], failWhen: { file: `src/${ticket}.txt`,
    contains: `${ticket} done`, unless: "src/FIX-1.txt" } };
  computer.script.rules.push(on("qa FIX-1#1 @prepare", B.requirements([{ from: 1, text: `${test} passes`,
    check: `fake-test ${test}` }])), on("qa FIX-1#1 @review", B.reject({ 1: "still fails for me" })));
  const rafi = rafiRunner(computer, dir);
  const crashed = await rafi("start . --steps 3", { crashAt: "2: sent, before any reply (FIX-1, fix" });
  assert.notEqual(crashed.code, 0, crashed.output);
  return { dir, computer, rafi, text: readFileSync(path.join(dir, ".rafi", "progress.yaml"), "utf8") };
}

test("17b (C225, P49): two clones each made a different FIX-1; after the merge one keeps FIX-1 and the other " +
  "arrives as FIX-2, with one line", async () => {
  const root = tempRoot();
  const one = await crashedInFix(root, "one", "suite/x.test", "T2");
  // Clone 2's file: the same run on another computer whose CI found suite/y.test failing after T3 (its own FIX-1).
  const file = parse(one.text) as { tickets: Record<string, { at: string; owned: Record<string, unknown> }> };
  file.tickets["FIX-1"]!.owned = { source: "ci", requirements: ["suite/y.test"], hint: "T3", unit: null };
  file.tickets["FIX-1"]!.at = "2026-11-01T15:00:00.000Z";
  const two = { text: stringify(file, { sortMapEntries: true }) };
  const empty = path.join(root, "base.yaml");
  writeFileSync(empty, "");
  const ours = path.join(root, "ours.yaml");
  writeFileSync(ours, one.text);
  const theirs = path.join(root, "theirs.yaml");
  writeFileSync(theirs, two.text);
  // What git's merge leaves: both sides added the file, so it conflicts wherever they differ.
  const merged = spawnSync("git", ["merge-file", "-p", "-L", "HEAD", "-L", "base", "-L", "clone-2", ours, empty,
    theirs], { encoding: "utf8" }).stdout;
  assert.match(merged, /^<{7} HEAD/m);
  writeFileSync(path.join(one.dir, ".rafi", "progress.yaml"), merged);
  // The import is what's tested: the resumed build is killed at its first turn, once the file has been read.
  const r = await one.rafi("resume", { crashAt: "2: sent, before any reply" });
  assert.ok(r.crashed, r.output);
  const said = r.output.split("\n").filter((l) => /FIX-1/.test(l) && /FIX-2/.test(l));
  assert.equal(said.length, 1, r.output);
  assert.match(said[0]!,
    /^(rafi: )?FIX-1: the other side has a different fix ticket with that id; kept it as FIX-2\.$/);
  const events = (JSON.parse((await one.rafi("stats export")).out) as EventsExport).events;
  const added = events.filter((e) => e.type === "ticket.added").map((e) => [e.ticket_id, e.source,
    (e.data as { requirements: string[] }).requirements]);
  assert.deepEqual(added, [["FIX-1", null, ["suite/x.test"]], ["FIX-2", "progress-file", ["suite/y.test"]]]);
  const after = parse(readFileSync(path.join(one.dir, ".rafi", "progress.yaml"), "utf8")) as
    { tickets: Record<string, { owned?: { hint: string } }> };
  assert.deepEqual([after.tickets["FIX-1"]?.owned?.hint, after.tickets["FIX-2"]?.owned?.hint], ["T2", "T3"]);
});
