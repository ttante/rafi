// Milestone: M5
// M5 section 4, "Damaged or hostile files: the progress file" (M4 threat 7; ARCH 3.7, Q-PORT-2; C224, C225): a
// `.rafi/progress.yaml` from another computer is data, validated before anything is read into state. On a clone: an
// entry older than the database's isn't imported; a `grant|…` answer key is refused and named; a 2 MB file or an
// alias bomb is refused with one line and the database wins; conflict markers with one invalid side keep the valid
// side with one line; a forged `T1: done` on a fresh clone is imported (that's the feature) and recorded as
// `progress.imported` with `source: progress-file`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import type { EventsExport } from "../checks/invariants.js";
import { fChain } from "../fixtures/f-chain.js";
import { tempRoot } from "../fixtures/common.js";
import { newComputer, rafiRunner } from "../harness/rafi.js";

const progress = (tickets: Record<string, unknown>, answers: Record<string, unknown> = {}) =>
  stringify({ version: 1, tickets, questions: {}, answers }, { sortMapEntries: true });

/** A fresh clone of F-CHAIN (no database) whose committed progress file is `text`. */
function clone(text: string) {
  const root = tempRoot();
  const dir = fChain(path.join(root, "clone"));
  mkdirSync(path.join(dir, ".rafi"), { recursive: true });
  writeFileSync(path.join(dir, ".rafi", "progress.yaml"), text);
  const computer = newComputer(root);
  return { dir, computer, rafi: rafiRunner(computer, dir) };
}

async function events(rafi: ReturnType<typeof rafiRunner>) {
  return (JSON.parse((await rafi("stats export")).out) as EventsExport).events;
}
const imported = (e: EventsExport["events"]) => e.filter((x) => x.type === "progress.imported")
  .map((x) => [(x.data as { entry: { key: string; status: string } }).entry.key,
    (x.data as { entry: { status: string } }).entry.status, x.source]);
const lines = (output: string, re: RegExp) => output.split("\n").filter((l) => re.test(l));

test("a forged T1: done on a fresh clone is imported, recorded as progress.imported from the progress file",
  async () => {
    const c = clone(progress({ T1: { status: "done", at: "2026-11-01T13:00:00Z" } }));
    const r = await c.rafi("start . --steps 1");
    assert.equal(r.code, 0, r.output);
    const e = await events(c.rafi);
    assert.deepEqual(imported(e), [["T1", "done", "progress-file"]]);
    assert.deepEqual(e.filter((x) => x.type === "ticket.started").map((x) => x.ticket_id), ["T2"]);
  });

test("an entry older than the database's isn't imported; the database wins", async () => {
  const c = clone(progress({}));
  assert.equal((await c.rafi("start . --steps 1")).code, 0);
  writeFileSync(path.join(c.dir, ".rafi", "progress.yaml"), progress({
    T1: { status: "blocked", at: "2026-11-01T12:00:00Z", reason: "from another computer, earlier" } }));
  const r = await c.rafi("start . --steps 1");
  assert.equal(r.code, 0, r.output);
  assert.deepEqual(imported(await events(c.rafi)), []);
  const file = parse(readFileSync(path.join(c.dir, ".rafi", "progress.yaml"), "utf8")) as
    { tickets: Record<string, { status: string }> };
  assert.equal(file.tickets.T1?.status, "done", "rewritten from the database");
});

test("Q-PORT-2: a grant answer key is refused and named; the rest of the file is imported", async () => {
  const c = clone(progress({ T1: { status: "done", at: "2026-11-01T13:00:00Z" } },
    { "grant|internet|T2": { at: "2026-11-01T13:00:00Z", choice: "always", source: "terminal" } }));
  const r = await c.rafi("start . --steps 1");
  assert.equal(r.code, 0, r.output);
  assert.equal(lines(r.output, /grant\|internet\|T2/).length, 1, r.output);
  assert.deepEqual(imported(await events(c.rafi)), [["T1", "done", "progress-file"]]);
  assert.doesNotMatch(readFileSync(path.join(c.dir, ".rafi", "progress.yaml"), "utf8"), /grant\|/);
});

test("a 2 MB file and an alias bomb are each refused with one line; nothing imported; the database wins",
  async () => {
    const big = `${"#".repeat(2_000_000)}\n${progress({ T1: { status: "done", at: "2026-11-01T13:00:00Z" } })}`;
    // 150 aliases of one anchor in an otherwise valid file: only the alias limit refuses it.
    const bomb = `version: 1\ntickets:\n  T1: {status: done, at: &t "2026-11-01T13:00:00Z"}\n` +
      Array.from({ length: 150 }, (_, i) => `  X${i}: {status: planned, at: *t}\n`).join("") +
      "questions: {}\nanswers: {}\n";
    for (const [name, text] of [["2 MB", big], ["alias bomb", bomb]] as const) {
      const c = clone(text);
      const r = await c.rafi("start . --steps 1");
      assert.equal(r.code, 0, `${name}: ${r.output}`);
      assert.equal(lines(r.output, /progress\.yaml/).length, 1, `${name}: one line\n${r.output}`);
      assert.deepEqual(imported(await events(c.rafi)), [], name);
      assert.deepEqual(parse(readFileSync(path.join(c.dir, ".rafi", "progress.yaml"), "utf8")).tickets.T1.status,
        "done", `${name}: T1 built here and the file rewritten from the database`);
    }
  });

test("conflict markers with one invalid side keep the valid side, with one line", async () => {
  const good = progress({ T1: { status: "done", at: "2026-11-01T13:00:00Z" } });
  const bad = "version: 1\ntickets:\n  T1: {status: shipped}\nquestions: {}\nanswers: {}\n";
  const c = clone(`<<<<<<< HEAD\n${bad}=======\n${good}>>>>>>> clone-2\n`);
  const r = await c.rafi("start . --steps 1");
  assert.equal(r.code, 0, r.output);
  assert.equal(lines(r.output, /side of the conflict isn't valid/).length, 1, r.output);
  assert.deepEqual(imported(await events(c.rafi)), [["T1", "done", "progress-file"]]);
});
