// Milestone: M5
// M5 plan 3.4's delivery-unit races: R10 (a merge wait's poll → unit.delivered vs `rafi stop`) and R19
// (delivery.yaml as the build last recorded it → a unit's git effects), forced with the fake gh's `onCall` and
// `onGit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { mergePr } from "../fakes/gh.js";
import type { RafiResult } from "../harness/rafi.js";
import { T1, once, setup } from "./git-race-helpers.js";

type Ev = { seq: number; type: string; data: unknown };
const unitOf = (e: Ev) => (e.data as { unit?: string }).unit;
/** A tickets.changed naming a unit (the first-write adoption's record names only tickets). */
const unitItems = (e: { data: unknown }) => (e.data as { items: { unit?: string }[] }).items.some((i) => i.unit);

test("R10: rafi stop lands between a merge wait's poll answer and its write: the owner records no delivery after " +
  "the stop request and nothing after build.stopped; rafi resume records unit.delivered once", async () => {
  const units = [{ id: "U1", tickets: ["T1"], branch_mode: "per-ticket", completion: "auto-merge" },
    { id: "U2", tickets: ["T2"], completion: "none", depends_on: ["U1"], dependency_mode: "wait" }];
  const { computer, rafi, exported } = setup({ units });
  const polls = () => computer.clock.whenTimer("poll", () => {
    polls();
    setImmediate(() => computer.clock.advance(60_000));
  });
  polls();
  let stop: RafiResult | null = null;
  computer.gh.onCall = async (args, gh) => {
    if (stop || args[0] !== "pr" || args[1] !== "view") return;
    // The poll asks; the provider's answer will be "merged", and meanwhile you run `rafi stop`.
    mergePr(gh, gh.prs.find((p) => p.head === T1)!.url);
    stop = await rafi("stop");
  };
  // T3 and T4 skipped: with T2 waiting on U1 there's nothing else to do, so the build polls U1's merge wait.
  const r = await rafi("start . --steps 2 --skip T3 --skip T4");
  assert.ok(stop, `the poll ran: ${r.output}`);
  assert.equal(r.code, 0, r.output);
  let e = (await exported()).events as unknown as Ev[];
  const at = (type: string) => e.find((x) => x.type === type)?.seq ?? Infinity;
  assert.ok(at("build.stopped") < Infinity, r.output);
  assert.deepEqual(e.filter((x) => x.seq > at("build.stopped")).map((x) => x.type), ["build.owner_released"]
    .filter((t) => e.some((x) => x.type === t && x.seq > at("build.stopped"))), "nothing after build.stopped");
  assert.deepEqual(e.filter((x) => x.type === "unit.delivered" && x.seq > at("build.stop_requested")), [],
    "no delivery recorded after the stop request");
  const again = await rafi("resume -y");
  assert.equal(again.code, 0, again.output);
  e = (await exported()).events as unknown as Ev[];
  assert.equal(e.filter((x) => x.type === "unit.delivered" && unitOf(x) === "U1").length, 1, again.output);
  assert.equal(e.filter((x) => x.type === "pr.merged").length, 1);
});

/** Edits `.tickets/delivery.yaml` in place (as you would while the build runs). */
function editUnits(project: string, fn: (units: Record<string, unknown>[]) => void): void {
  const file = path.join(project, ".tickets", "delivery.yaml");
  const doc = YAML.parse(readFileSync(file, "utf8")) as { units: Record<string, unknown>[] };
  fn(doc.units);
  writeFileSync(file, YAML.stringify(doc));
}

const UNITS = [{ id: "U1", tickets: ["T1"], branch_mode: "per-ticket", completion: "pr" },
  { id: "U2", tickets: ["T2"], branch_mode: "per-ticket", completion: "none" },
  { id: "U3", tickets: ["T3"], branch_mode: "per-ticket", completion: "none", depends_on: ["U1"],
    dependency_mode: "wait" }];

test("R19 (a): delivery.yaml edited at U1's first lookup: one tickets.changed, then U1 delivered as none (no push, " +
  "no PR) and U3 eligible at once", async () => {
  const { project, computer, rafi, exported, of } = setup({ units: UNITS });
  let committed = false;
  const onGit = once((a) => {
    // U1's delivery's first lookup: its branch's tip, after T1's commit moved it.
    if (a[0] === "update-ref" && a.includes(`refs/heads/${T1}`)) committed = true;
    if (!committed || a[0] !== "rev-parse" || !a.includes(`refs/heads/${T1}^{commit}`)) return false;
    editUnits(project, (units) => {
      units[0]!.completion = "none";
      delete units[2]!.depends_on;
    });
    return true;
  });
  const r = await rafi("start . --steps 3", { onGit });
  assert.equal(r.code, 0, r.output);
  const e = await exported();
  const changed = of(e, "tickets.changed").filter((x) => unitItems(x));
  assert.equal(changed.length, 1, r.output);
  assert.ok((changed[0]!.data as { items: { unit?: string }[] }).items.some((i) => i.unit === "U1"));
  assert.deepEqual(of(e, "git.pushed"), [], "no push");
  assert.deepEqual(computer.gh.prs, [], "no PR");
  assert.equal(of(e, "unit.delivered").filter((x) => (x.data as { unit: string }).unit === "U1").length, 1);
  const seq = (type: string, id: string) => e.events.find((x) => x.type === type && x.ticket_id === id)?.seq ?? 0;
  assert.ok(seq("ticket.started", "T3") > 0, "U3 eligible once U1's dependency was removed");
});

test("R19 (b): delivery.yaml edited after U1's push intent: the push and PR go ahead as intended; the next safe " +
  "point records the change once and says U1 was already delivering", async () => {
  const { project, computer, rafi, exported, of } = setup({ units: UNITS });
  const onGit = once((a) => {
    if (a[0] !== "push") return false;
    editUnits(project, (units) => { units[0]!.completion = "none"; });
    return true;
  });
  const r = await rafi("start . --steps 3", { onGit });
  assert.equal(r.code, 0, r.output);
  const e = await exported();
  assert.equal(of(e, "tickets.changed").filter((x) => unitItems(x)).length, 1,
    r.output);
  assert.equal(of(e, "git.pushed").length, 1, "the push went ahead");
  assert.equal(computer.gh.prs.length, 1, "the PR went ahead");
  assert.match(r.output, /U1 was already delivering/);
});

test("R19 (c): renaming U1's branch after it exists keeps the branch and says so", async () => {
  const units = [{ id: "U1", tickets: ["T1", "T2"], branch: "release/x", branch_mode: "shared", completion: "none" }];
  const { project, computer, rafi, exported, of } = setup({ units });
  const onGit = once((a) => {
    if (a[0] !== "commit-tree") return false;
    editUnits(project, (u) => { u[0]!.branch = "release/y"; });
    return true;
  });
  const r = await rafi("start . --steps 2", { onGit });
  assert.equal(r.code, 0, r.output);
  const created = of(await exported(), "git.branch_created").map((x) => (x.data as { branch: string }).branch);
  assert.deepEqual(created, ["release/x"]);
  assert.match(r.output, /U1 keeps release\/x, which already exists/);
});
