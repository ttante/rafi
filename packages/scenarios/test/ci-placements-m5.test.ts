// Milestone: M5
// ARCH 6.10's `checks.ci_when` placements end to end (4b-2's open item; C213, C270): `each-ticket` (a CI point
// after each ticket's checks and review, before the next starts and before its unit is delivered) and
// `light-each-pr-full-end` (`light` before each unit's merge while the scope runs, `full` once at the end).
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { git, tempRoot } from "../fixtures/common.js";
import { fTests } from "../fixtures/f-tests.js";
import { newComputer, rafiRunner } from "../harness/rafi.js";
import { B, on } from "../fakes/script/behaviors.js";
import type { EventsExport } from "../checks/invariants.js";

type Ev = EventsExport["events"][number];
const data = (e: Ev) => e.data as Record<string, unknown>;

function setup(o: { when: string; units?: readonly Record<string, unknown>[] }) {
  const root = tempRoot();
  const project = fTests(path.join(root, "p"), { qa: false, units: o.units,
    config: { checks: { test_runner: "fake-test", ci_when: o.when } } });
  const computer = newComputer(root);
  const rafi = rafiRunner(computer, project);
  const events = async () => (JSON.parse((await rafi("stats export")).out) as EventsExport).events;
  return { project, computer, rafi, events };
}

const seqOf = (es: readonly Ev[], type: string, ok: (e: Ev) => boolean = () => true) =>
  es.find((e) => e.type === type && ok(e))?.seq ?? -1;

test("each-ticket: one full suite run per ticket, after it's done and before the next starts; each tests that " +
  "ticket's work on the unit's branch; the unit is delivered after the last", async () => {
  const { project, rafi, events } = setup({ when: "each-ticket" });
  const r = await rafi("start . --steps 3");
  assert.equal(r.code, 0, r.output);
  const e = await events();
  const suites = e.filter((x) => x.type === "suite.run");
  assert.deepEqual(suites.map((s) => [data(s).unit, data(s).tests, data(s).outcome]),
    [["T1", "full", "passed"], ["T2", "full", "passed"], ["T3", "full", "passed"]]);
  for (const [n, s] of suites.entries()) {
    const id = `T${n + 1}`;
    assert.ok(s.seq > seqOf(e, "delivery.done", (x) => x.ticket_id === id), `${id}'s point after it's done`);
    if (n < 2) {
      assert.ok(s.seq < seqOf(e, "ticket.started", (x) => x.ticket_id === `T${n + 2}`), "before the next starts");
    }
    const commit = String(data(s).commit);
    assert.match(git(project, ["show", `${commit}:src/${id}.txt`]), /done/, `${id}'s point tests its work`);
    if (n < 2) assert.doesNotMatch(git(project, ["show", `${commit}:src/T${n + 2}.txt`]), /done/);
  }
  assert.equal(e.filter((x) => x.type === "ci.result").length, 3);
  assert.ok(seqOf(e, "unit.delivered") > suites.at(-1)!.seq, "the unit is merged after its last point");
});

test("light-each-pr-full-end: light (related tests only) before U1's merge while the scope runs; full once at the " +
  "end, before U2's merge", async () => {
  const units = [{ id: "U1", tickets: ["T1"], branch_mode: "shared", completion: "direct-merge" },
    { id: "U2", tickets: ["T2", "T3"], branch_mode: "shared", completion: "direct-merge" }];
  const { computer, rafi, events } = setup({ when: "light-each-pr-full-end", units });
  computer.checks.tests["t1.test"] = { outcomes: ["pass"], related: ["src/T1.txt"] };
  const r = await rafi("start . --steps 3");
  assert.equal(r.code, 0, r.output);
  const e = await events();
  const suites = e.filter((x) => x.type === "suite.run");
  assert.deepEqual(suites.map((s) => [data(s).unit, data(s).tests]), [["U1", "light"], ["build", "full"]]);
  const delivered = (u: string) => seqOf(e, "unit.delivered", (x) => data(x).unit === u);
  assert.ok(suites[0]!.seq < delivered("U1") && delivered("U1") < seqOf(e, "ticket.started",
    (x) => x.ticket_id === "T2"), "U1's light point, then its merge, while the scope still runs");
  assert.ok(suites[1]!.seq > seqOf(e, "delivery.done", (x) => x.ticket_id === "T3"), "full once every ticket's done");
  assert.ok(suites[1]!.seq < delivered("U2"), "full before U2's merge");
  const ci = computer.checks.log.filter((l) => l.cwd.includes(`${path.sep}ci${path.sep}`) &&
    !l.args.includes("--listTests"));
  const files = (l: (typeof ci)[number]) => l.args.filter((a) => !a.startsWith("-"));
  assert.ok(ci.length >= 2, JSON.stringify(ci.map((l) => [l.cwd, l.args])));
  assert.deepEqual(files(ci[0]!), ["t1.test"], "light runs only the tests related to what the build changed");
  assert.ok(ci.slice(1).some((l) => files(l).length === 0), "full runs the whole suite (no file arguments)");
});

test("light picks the tests related to a non-ASCII file the build changed, by its real name (part 6)", async () => {
  const units = [{ id: "U1", tickets: ["T1"], branch_mode: "shared", completion: "direct-merge" },
    { id: "U2", tickets: ["T2", "T3"], branch_mode: "shared", completion: "direct-merge" }];
  const { computer, rafi } = setup({ when: "light-each-pr-full-end", units });
  computer.script.rules.push(on("builder T1#1 @build", B.also({ edit: "src/Café.txt", content: "café\n" })));
  computer.checks.tests["t1.test"] = { outcomes: ["pass"], related: ["src/Café.txt"] };
  const r = await rafi("start . --steps 3");
  assert.equal(r.code, 0, r.output);
  const ci = computer.checks.log.filter((l) => l.cwd.includes(`${path.sep}ci${path.sep}`));
  const listed = ci.find((l) => l.args.includes("--listTests"));
  assert.ok(listed?.args.includes("src/Café.txt"), JSON.stringify(ci.map((l) => l.args)));
  assert.deepEqual(ci.filter((l) => !l.args.includes("--listTests")).map((l) => l.args.filter((a) => !a
    .startsWith("-")))[0], ["t1.test"], "light runs the related test");
});
