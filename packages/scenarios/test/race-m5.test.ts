// Milestone: M5
// M5 plan 3.4's race tests, part 4a. Each forces its interleaving with the harness (whenTimer, busyAt).
//   R1 (C209): `rafi tickets complete` from another process while the build works on that ticket is refused in
//   the append's own transaction: exactly one writer wins, and the log has no violation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse, stringify } from "yaml";
import { setTickets } from "../fixtures/common.js";
import { approvedPlan } from "../fixtures/plan.js";
import { B, on } from "../fakes/script/behaviors.js";
import { tempRoot } from "../fixtures/common.js";
import { fChain } from "../fixtures/f-chain.js";
import { newComputer, rafiRunner, type LiveRafi, type RafiResult } from "../harness/rafi.js";
import type { EventsExport } from "../checks/invariants.js";

function setup() {
  const root = tempRoot();
  const project = fChain(root);
  const computer = newComputer(root);
  const rafi = rafiRunner(computer, project);
  const exported = async () => JSON.parse((await rafi("stats export")).out) as EventsExport;
  return { project, computer, rafi, exported };
}

test("R1: tickets complete on the ticket a live build is working on is refused; the build finishes it", async () => {
  const { computer, rafi, exported } = setup();
  computer.script.rules.push(on("builder T1#1 @build", B.slow(2)));
  const owner = rafi.start("start . --steps 1 --no-qa", { tty: true });
  let refused = null as RafiResult | null;
  computer.clock.whenTimer("agent", async () => {
    refused = await rafi("tickets complete T1 --evidence 'did it myself'");
  });
  assert.equal((await owner.done()).code, 0);
  assert.ok(refused, "the competing command ran during the builder's turn");
  assert.equal(refused!.code, 1, refused!.output);
  assert.match(refused!.output, /T1 is being worked on by build/);
  const e = await exported();
  assert.equal(e.events.filter((x) => x.type === "ticket.status_set").length, 0, "the command wrote nothing");
  assert.equal(e.events.filter((x) => x.type === "delivery.done" && x.ticket_id === "T1").length, 1);
  const ok = await rafi("tickets complete T2 --evidence 'by hand'");
  assert.equal(ok.code, 0, "no live build: another ticket's status changes");
});

// Part 4a-2 (plan 10.8). R2, R3, R4, R7 and the loop's "decide again" path, each forced at a fixed point.
const rowsOf = (project: string, sql: string) => {
  const db = new DatabaseSync(path.join(project, ".rafi", "state.sqlite3"), { readOnly: true });
  try { return db.prepare(sql).all() as Record<string, unknown>[]; } finally { db.close(); }
};
const changes = (project: string) => rowsOf(project, "SELECT actor, data FROM events WHERE type = 'tickets.changed' " +
  "ORDER BY seq").map((r) => ({ actor: String(r.actor), data: JSON.parse(String(r.data)) as { digest?: string } }))
  .filter((c) => c.data.digest);
async function until(cond: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 20_000;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
const sha = (file: string) => `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;

test("R2: tickets reorder held between its rename and its record while the build's safe point re-reads the file: " +
  "one tickets.changed, and the log's digest is the file's", async () => {
  const { project, computer, rafi, exported } = setup();
  computer.script.rules.push(on("builder T1#1 @build", B.slow(2)));
  const owner = rafi.start("start . --steps 2 --no-qa", { tty: true });
  let reorder = null as Promise<RafiResult> | null;
  computer.clock.whenTimer("agent", () => {
    reorder = rafi("tickets reorder T4 --order 1", { pauseAt: { at: (o) => o.startsWith("7: after the tickets.yaml " +
      "rename"), fn: () => until(() => changes(project).length > 0, "the build's safe point to record the edit") } });
  });
  const built = await owner.done();
  assert.equal(built.code, 0, built.output);
  const moved = await reorder!;
  assert.equal(moved.code, 0, moved.output);
  assert.match(moved.output, /already recorded it/);
  const recorded = changes(project);
  assert.equal(recorded.length, 1, JSON.stringify(recorded));
  assert.equal(recorded[0]!.actor, "engine", "the safe point saw it first");
  assert.equal(recorded[0]!.data.digest, sha(path.join(project, ".tickets", "tickets.yaml")));
  const e = await exported();
  assert.deepEqual(e.events.filter((x) => x.type === "delivery.done").map((x) => x.ticket_id), ["T1", "T4"],
    "the next ticket is the reordered one");
});

test("R3: the tickets file is edited while PRM-71 is open; Proceed asks again, about the new files", async () => {
  const { project, rafi, exported } = setup();
  approvedPlan(project);
  setTickets(project, { T3: { acceptance: ["Ticket 3 works.", "And it logs."] } });
  const live = rafi.start("start . --steps 1 --no-qa", { tty: true });
  await live.expect(/How does this plan look\?/);
  setTickets(project, { T4: { acceptance: ["Ticket 4 works, twice."] } });
  live.send("1\n");
  await live.expect(/How does this plan look\?/);
  live.send("1\n");
  const r = await live.done();
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /changed while rafi was choosing the scope/);
  const approved = (await exported()).events.filter((x) => x.type === "scope.approved")
    .map((x) => (x.data as { by: string }).by);
  assert.deepEqual(approved, ["user"], "the first Proceed wrote nothing");
  const again = await rafi("start . --steps 1 --no-qa", { tty: true });
  assert.doesNotMatch(again.output, /How does this plan look\?/, "the approval is for the files as they are");
});

test("R4: the tickets file changes between --to-ticket's selection and build.started; the start chooses again",
  async () => {
    const { project, rafi, exported } = setup();
    // The selection's load reads tickets.yaml and then delivery.yaml; the next read of tickets.yaml is the check
    // before build.started. The edit lands just before it.
    let selected = false;
    let edited = false;
    const r = await rafi("start . --to-ticket T3 --no-qa", { onRead: (read) => {
      if (read.endsWith("delivery.yaml")) selected = true;
      else if (read.endsWith("tickets.yaml") && selected && !edited) {
        edited = true;
        const file = path.join(project, ".tickets", "tickets.yaml");
        const doc = parse(readFileSync(file, "utf8")) as { tickets: { id: string; order: number }[] };
        const t3 = doc.tickets.splice(2, 1)[0]!;
        doc.tickets = [t3, ...doc.tickets].map((t, n) => ({ ...t, order: n + 1 }));
        writeFileSync(file, stringify(doc));
      }
    } });
    assert.equal(r.code, 0, r.output);
    assert.match(r.output, /choosing it again from the new files/);
    const started = (await exported()).events.find((x) => x.type === "build.started")!;
    assert.deepEqual((started.data as { tickets: string[] }).tickets, ["T3"]);
  });

test("R7: two rafi agents at once; the second waits for the first's lock, and both changes land", async () => {
  const { project, computer, rafi } = setup();
  let second = null as Promise<RafiResult> | null;
  let firstDone = () => undefined as void;
  const finished = new Promise<void>((resolve) => { firstDone = resolve; });
  const first = rafi("agents --agent-type builder --model m-one", { pauseAt: { at: (o) => o.startsWith(
    "7: before the rafi-config.yaml rename"), fn: async () => {
    const waiting = new Promise<void>((resolve) => computer.clock.whenTimer("backoff", async () => {
      resolve();
      await finished;
    }));
    second = rafi("agents --agent-type qa --model m-two");
    await Promise.race([waiting, second]);
  } } }).then((x) => { firstDone(); return x; });
  assert.equal((await first).code, 0);
  assert.equal((await second!).code, 0);
  const saved = parse(readFileSync(path.join(project, "rafi-config.yaml"), "utf8")).agent_defaults;
  assert.equal(saved.roles?.builder?.model, "m-one");
  assert.equal(saved.roles?.qa?.model, "m-two");
  assert.equal(saved.revision, 2, "each save bumped the revision once");
});

test("the loop decides again when a rafi tickets command changed the chosen ticket before ticket.started", async () => {
  const { rafi, computer, exported } = setup();
  let blocked = null as RafiResult | null;
  computer.clock.whenTimer("backoff", async () => {
    blocked = await rafi("tickets block T1 --summary 'not yet'");
  });
  // The 4th write is T1's ticket.started (after build.started, the owner and the adoption): busy once, so the
  // block lands between decide's choice and that write.
  const r = await rafi("start . --steps 1 --no-qa", { faults: { busyAt: 4 } });
  assert.equal(r.code, 0, r.output);
  assert.equal(blocked!.code, 0, blocked!.output);
  const e = await exported();
  assert.deepEqual(e.events.filter((x) => x.type === "ticket.started").map((x) => x.ticket_id), ["T2"]);
  assert.equal(e.events.filter((x) => x.type === "build.failed").length, 0);
});

test("C211: a hand edit of tickets.yaml during a build is recorded once at the next safe point, told in one line, " +
  "and applied from the next step; a broken file keeps the last good definitions, said once", async () => {
  const { project, computer, rafi, exported } = setup();
  const file = path.join(project, ".tickets", "tickets.yaml");
  const saved = readFileSync(file, "utf8");
  computer.script.rules.push(on("builder T1#1 @build", B.slow(2)));
  computer.clock.whenTimer("agent", () => {
    const doc = parse(saved) as { tickets: { id: string; order: number }[] };
    const t7 = doc.tickets.pop()!;
    doc.tickets = [doc.tickets[0]!, t7, ...doc.tickets.slice(1)].map((t, n) => ({ ...t, order: n + 1 }));
    writeFileSync(file, stringify(doc));
  });
  const r = await rafi("start . --steps 2 --no-qa");
  assert.equal(r.code, 0, r.output);
  assert.equal(r.output.match(/\.tickets\/ changed: /g)?.length, 1, r.output);
  assert.match(r.output, /T7 \(order\)/);
  const recorded = changes(project);
  assert.equal(recorded.length, 1, JSON.stringify(recorded));
  assert.equal(recorded[0]!.data.digest, sha(file));
  let e = await exported();
  assert.deepEqual(e.events.filter((x) => x.type === "delivery.done").map((x) => x.ticket_id), ["T1", "T7"]);
  writeFileSync(file, readFileSync(file, "utf8").replace("risk: Low", "risk: Unknown"));
  const broken = await rafi("start . --steps 2 --no-qa");
  assert.notEqual(broken.code, 0, "a broken file at the start is refused, as before");
  writeFileSync(file, readFileSync(file, "utf8").replace("risk: Unknown", "risk: Low"));
  computer.script.rules.push(on("builder T2#1 @build", B.slow(2)));
  computer.clock.whenTimer("agent", () => {
    writeFileSync(file, readFileSync(file, "utf8").replace("risk: Low", "risk: Unknown"));
  });
  const kept = await rafi("start . --steps 2 --no-qa");
  assert.equal(kept.code, 0, kept.output);
  assert.equal(kept.output.match(/keeps building from the last good definitions/g)?.length, 1, kept.output);
  e = await exported();
  assert.deepEqual(e.events.filter((x) => x.type === "delivery.done").map((x) => x.ticket_id), ["T1", "T7", "T2",
    "T3"]);
});

test("R8: rafi resume takes the interrupted build between tickets reset's check and its write; the reset is " +
  "refused and says so", async () => {
  const { project, computer, rafi, exported } = setup();
  const crashed = await rafi("start . --steps 1 --no-qa", { crashAt: "2: sent, before any reply (T1, build" });
  assert.ok(crashed.crashed);
  const owners = () => rowsOf(project, "SELECT seq FROM events WHERE type = 'build.owner_acquired'").length;
  const before = owners();
  computer.script.rules.push(on("builder T1#1 @build", B.slow(2)));
  let resume = null as LiveRafi | null;
  const reset = await rafi("tickets reset T1 --yes", { pauseAt: { at: (o) => o.startsWith("7: before the tickets " +
    "reset is recorded"), fn: async () => {
    resume = rafi.start("resume -y", { tty: true });
    await until(() => owners() > before, "rafi resume to take the build");
    // It runs to the end and lets go of the lease, so only the reset's "no build event since" check is left.
    await resume.done();
  } } });
  assert.equal(reset.code, 1, reset.output);
  assert.match(reset.output, /A build started or resumed while rafi was resetting/);
  assert.equal((await resume!.done()).code, 0);
  const e = await exported();
  assert.equal(e.events.filter((x) => x.type === "ticket.status_set").length, 0, "the reset wrote nothing");
  assert.equal(e.events.filter((x) => x.type === "delivery.done" && x.ticket_id === "T1").length, 1);
});
