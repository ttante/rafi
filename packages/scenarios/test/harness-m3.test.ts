// Item 17 (M3 plan 3.2): the new fake behaviors on both in-process fakes (C123), the `outside` step (the user, not
// the agent), Codex `read` as a `cat` command, the transcript's cwd, the checks log's cwd, fixture overrides and
// copyProject (C127).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import type { EventsExport } from "../checks/invariants.js";
import { B, on } from "../fakes/script/behaviors.js";
import { addFiles, git, setTickets, tempRoot } from "../fixtures/common.js";
import { fChain } from "../fixtures/f-chain.js";
import { fOne } from "../fixtures/f-one.js";
import { fTestsLocal } from "../fixtures/f-tests.js";
import { newComputer, rafiRunner } from "../harness/rafi.js";
import { copyProject } from "../harness/scenario.js";

async function exported(rafi: ReturnType<typeof rafiRunner>): Promise<EventsExport> {
  const r = await rafi("stats export");
  assert.equal(r.code, 0, r.output);
  return JSON.parse(r.out) as EventsExport;
}

const of = (e: EventsExport, type: string) => e.events.filter((x) => x.type === type).map((x) => x.data as never);

for (const runtime of ["claude", "codex"] as const) {
  test(`${runtime}: outside changes a file with no tool event; read is a tool event; the transcript has cwd`,
    async () => {
      const root = tempRoot();
      const project = fOne(root);
      const computer = newComputer(root);
      const rafi = rafiRunner(computer, project);
      computer.script.rules.push(on("builder T1#1", B.also({ outside: { edit: "README.md", content: "yours\n" } },
        { read: "package.json" })));
      const r = await rafi(`start . --steps 1 --agent ${runtime}`);
      assert.equal(r.code, 0, r.output);
      assert.equal(readFileSync(path.join(project, "README.md"), "utf8"), "yours\n");
      const tools = of(await exported(rafi), "turn.tool") as
        { tool: string; command: string | null }[];
      assert.ok(!tools.some((t) => String(t.command).includes("README.md")), JSON.stringify(tools));
      const read = tools.find((t) => String(t.command).includes("package.json"));
      assert.ok(read, JSON.stringify(tools));
      if (runtime === "codex") assert.equal(read.command, "cat package.json");
      else assert.equal(read.tool, "Read");
      assert.ok(computer.script.transcript.length > 0);
      for (const t of computer.script.transcript) assert.equal(t.cwd, project);
    });
}

for (const runtime of ["claude", "codex"] as const) {
  test(`${runtime}: requirements, reject with a note, then unable; the verdicts are recorded as scripted`, async () => {
    const root = tempRoot();
    const project = fOne(root);
    const computer = newComputer(root);
    const rafi = rafiRunner(computer, project);
    computer.script.rules.push(
      on("qa T1 @prepare", B.requirements([{ from: 1, text: "It shows the message.", check: null },
        { from: 1, text: "The empty state shows.", check: null }])),
      on("qa T1#1 @review", B.reject({ 2: "empty state missing" })),
      on("qa T1#2 @review", B.unable(1, "browser")));
    const r = await rafi(`start . --steps 1 --agent ${runtime}`);
    assert.equal(r.code, 0, r.output);
    const verdicts = of(await exported(rafi), "verdict.recorded") as { results: { req: number; status: string;
      note: string | null; needs: string | null }[] }[];
    assert.equal(verdicts.length, 2);
    assert.deepEqual(verdicts[0]!.results.map((x) => [x.req, x.status, x.note]),
      [[1, "satisfied", null], [2, "not-satisfied", "empty state missing"]]);
    assert.deepEqual(verdicts[1]!.results.map((x) => [x.req, x.status, x.needs]),
      [[1, "unable", "browser"], [2, "satisfied", null]]);
  });
}

test("sameReject repeats the note; pass is the happy verdict; malformedOf cuts any reply at a byte", () => {
  const ctx = { cwd: ".", message: "requirements R1, R2." };
  const meta = { role: "qa", ticket: "T1", step: "review", attempt: 1 };
  const same = B.sameReject(2)(meta, ctx).reply as { results: { req: number; status: string; note: string }[] };
  assert.deepEqual(same.results.map((x) => x.status), ["satisfied", "not-satisfied"]);
  const again = B.sameReject(2)(meta, ctx).reply as typeof same;
  assert.equal(again.results[1]!.note, same.results[1]!.note, "the same note each time");
  const pass = B.pass()(meta, ctx).reply as { results: { status: string }[] };
  assert.ok(pass.results.every((x) => x.status === "satisfied"));
  const reply = { requirements: [{ from: 1, text: "x", check: null, expect: null }], in_scope: [], out_of_scope: [],
    risks: [], add_tags: [] };
  const bad = B.malformedOf(reply, 300);
  assert.equal(bad.raw!.indexOf("trailing"), 300);
  assert.deepEqual(JSON.parse(bad.raw!.slice(0, 300)), reply);
  assert.deepEqual(B.repairOf(reply).reply, reply);
});

test("setTickets overrides one ticket's fields and commits; addFiles commits new files", () => {
  const root = tempRoot();
  const project = fChain(root);
  setTickets(project, { T1: { risk: "High", qa_preparation: { depth: "focused" }, acceptance: ["A.", "B."] } });
  addFiles(project, { "src/a.js": "a\n" });
  const tickets = (parse(readFileSync(path.join(project, ".tickets", "tickets.yaml"), "utf8")) as
    { tickets: Record<string, unknown>[] }).tickets;
  assert.equal(tickets[0]!.risk, "High");
  assert.deepEqual(tickets[0]!.qa_preparation, { depth: "focused" });
  assert.deepEqual(tickets[0]!.acceptance, ["A.", "B."]);
  assert.equal(tickets[1]!.risk, "Low");
  assert.equal(git(project, ["status", "--porcelain"]), "");
  assert.ok(existsSync(path.join(project, "src", "a.js")));
});

test("copyProject makes a byte copy with its own git and database; the checks log records each run's cwd",
  async () => {
    const root = tempRoot();
    const project = fTestsLocal(root);
    const computer = newComputer(root);
    const rafi = rafiRunner(computer, project);
    const r = await rafi("start . --ticket T1 --steps 1");
    assert.equal(r.code, 0, r.output);
    assert.ok(computer.checks.log.length > 0);
    for (const entry of computer.checks.log) assert.equal(entry.cwd, project);
    const copy = copyProject(project);
    assert.notEqual(copy, project);
    assert.ok(existsSync(path.join(copy, ".rafi", "state.sqlite3")));
    assert.equal(git(copy, ["rev-parse", "HEAD"]), git(project, ["rev-parse", "HEAD"]));
    addFiles(copy, { "only-in-copy.txt": "x\n" });
    assert.ok(!existsSync(path.join(project, "only-in-copy.txt")));
    assert.equal((await rafiRunner(computer, copy)("tickets show T1 --json")).code, 0);
  });
