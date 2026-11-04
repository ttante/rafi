// M4 review, findings 1 and 2: one live build per checkout (ARCH 8.5) holds when a second command races a takeover.
// The interleavings are forced at fixed points, not by timing: `rafi start` waits on its no-sandbox prompt (after it
// has looked at the crashed build) while `rafi resume` takes that build over; `rafi reset` is held at its first git
// command while `rafi resume` tries to take the build it's resetting; `rafi stop`'s write on a waiting build with no
// owner waits out a busy database (fault `busyAt`) while `rafi resume` takes the build over; `rafi stop` on a live
// build waits the same way while its owner goes on to wait and release it. The wall-clock bound in `until` only turns
// a hang into a failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { B, on } from "../fakes/script/behaviors.js";
import { tempRoot } from "../fixtures/common.js";
import { fOne } from "../fixtures/f-one.js";
import { newComputer, rafiRunner, type LiveRafi, type RafiResult } from "../harness/rafi.js";

const CRASH_T1 = "2: sent, before any reply (T1, build";

function setup() {
  const root = tempRoot();
  const project = fOne(root);
  const computer = newComputer(root);
  const rafi = rafiRunner(computer, project);
  const file = path.join(project, ".rafi", "state.sqlite3");
  const rows = (sql: string) => {
    const db = new DatabaseSync(file, { readOnly: true });
    try { return db.prepare(sql).all() as Record<string, unknown>[]; } finally { db.close(); }
  };
  const count = (type: string) => rows(`SELECT seq FROM events WHERE type = '${type}'`).length;
  return { project, computer, rafi, rows, count };
}

async function until(cond: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 20_000;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("finding 1: rafi resume takes the crashed build while rafi start waits on a prompt; start takes no second " +
  "build and offers to attach", { timeout: 60_000 }, async () => {
  const { computer, rafi, rows, count } = setup();
  assert.ok((await rafi("start . --steps 1", { crashAt: CRASH_T1 })).crashed);
  const [crashed] = rows("SELECT run_id FROM events WHERE type = 'build.started'").map((r) => String(r.run_id));
  computer.checks.sandbox = "missing";
  const start = rafi.start("start . --steps 1", { tty: true });
  // start has looked at the crashed build (nothing runs it) and now asks about the missing sandbox.
  await start.expect(/This machine has no sandbox for tests/);
  computer.script.rules.push(on("builder T1#1 @build", B.slow(2)));
  let ended = false;
  void start.done().then(() => { ended = true; });
  computer.clock.whenTimer("agent", async () => {
    // resume owns the crashed build and its redone builder turn is in flight; the clock holds still meanwhile.
    start.send("1\n");
    await until(() => /Attach to it\?|already running here/.test(start.output()) || count("build.started") > 1 ||
      ended, "start to decide");
  });
  const resume = rafi.start("resume -y");
  await until(() => /Attach to it\?/.test(start.output()) || count("build.started") > 1 || ended, "the offer");
  start.send("1\n");
  const [s, r] = await Promise.all([start.done(), resume.done()]);
  assert.equal(count("build.started"), 1, `one build, ${crashed}:\n${s.output}`);
  assert.deepEqual(rows("SELECT DISTINCT run_id FROM events WHERE run_id IS NOT NULL").map((x) => x.run_id),
    [crashed], "nothing written for a second run");
  assert.equal(count("build.owner_lost"), 1, "only resume's takeover wrote build.owner_lost");
  assert.equal(count("build.owner_acquired"), 2, "the first owner, then resume");
  assert.match(s.output, new RegExp(`Build ${crashed} is already running here`));
  assert.match(s.output, new RegExp(`Following build ${crashed}`), "start attached");
  assert.equal(s.code, 0, s.output);
  assert.equal(r.code, 0, r.output);
});

test("finding 2: rafi resume can't take a build while rafi reset changes the checkout", { timeout: 60_000 },
  async () => {
    const { project, rafi, rows, count } = setup();
    assert.ok((await rafi("start . --steps 1", { crashAt: CRASH_T1 })).crashed);
    writeFileSync(path.join(project, "README.md"), "edited by me\n");
    let resume: LiveRafi | null = null;
    const reset = await rafi("reset --build --action restart-current --cleanup discard --yes", {
      onGit: async () => {
        if (resume) return;
        // reset decided the build has no live owner; before its first git command, resume tries to take it.
        resume = rafi.start("resume -y");
        await until(() => count("build.owner_acquired") > 1 || /Following build/.test(resume!.output()),
          "resume to decide");
      },
    });
    assert.ok(resume, "reset ran git");
    const r = await (resume as LiveRafi).done();
    assert.equal(reset.code, 0, reset.output);
    assert.equal(count("build.owner_acquired"), 1, `resume took no ownership:\n${r.output}`);
    assert.equal(count("build.resumed"), 0);
    assert.match(r.output, /Following build/, "resume attached to the build being reset");
    assert.equal(r.code, 0, r.output);
    assert.deepEqual(rows("SELECT type FROM events ORDER BY seq DESC LIMIT 1").map((x) => x.type), ["build.reset"]);
  });

const FOUR = [1, 2, 3, 4].map((n) => ({ from: 1, text: `Requirement number ${n} holds.`, check: null }));

const rejectAll = () => [on("qa T1 @prepare", B.requirements(FOUR)),
  ...[1, 2, 3, 4].map((n) => on(`qa T1#${n} @review`, B.reject({ [n]: `R${n} not yet` }))),
  ...[2, 3, 4].map((n) => on(`builder T1#${n}`, B.also({ edit: "src/T1.txt", content: `fix ${n}\n` })))];

test("fix 8: rafi resume takes a waiting build while rafi stop waits to write; stop asks the new owner to stop " +
  "instead of stopping the build under it", { timeout: 60_000 }, async () => {
  const { computer, rafi, rows, count } = setup();
  // QA rejects every attempt, so T1 ends on a "What next?" question; with no terminal the owner waits and releases.
  computer.script.rules.push(...rejectAll());
  const waiting = await rafi("start . --steps 1");
  assert.match(waiting.output, /is waiting on question/, waiting.output);
  const types = () => rows("SELECT type FROM events ORDER BY seq").map((r) => String(r.type));
  assert.deepEqual(types().slice(-1), ["build.owner_released"], "waiting, released: no live owner");
  let resume: LiveRafi | null = null;
  computer.clock.whenTimer("backoff", async () => {
    // stop decided the build has no live owner; its write is busy, and meanwhile resume takes the build over.
    resume = rafi.start("resume", { tty: true });
    await resume.expect(/What next\?/);
  });
  const stop = await rafi("stop", { faults: { busyAt: 1 } });
  assert.ok(resume, "stop's write waited");
  const r = await (resume as LiveRafi).done();
  const after = types().slice(types().lastIndexOf("build.owner_acquired"));
  assert.deepEqual(after, ["build.owner_acquired", "build.waiting", "build.stop_requested", "build.stopped",
    "build.owner_released"],
    `the owner stopped its own build:\n${stop.output}\n${r.output}`);
  assert.equal(count("build.stopped"), 1);
  assert.deepEqual(rows("SELECT data FROM events WHERE type = 'build.owner_released' ORDER BY seq DESC LIMIT 1")
    .map((x) => JSON.parse(String(x.data)).reason), ["stopped"], "the owner stopped and released it");
  assert.equal(stop.output.trim(), "rafi: Stopping after the current step. Run `rafi stop` again or press Ctrl+C to " +
    "stop now.", "stop asked the new owner");
  assert.equal(stop.code, 0);
  assert.match(r.output, /stopped after the current step/, r.output);
  assert.equal(r.code, 0, r.output);
});

test("fix 9: the owner releases its waiting build while rafi stop waits to write its request; stop decides again " +
  "and stops the build itself", { timeout: 60_000 }, async () => {
  const { computer, rafi, rows, count } = setup();
  computer.script.rules.push(...rejectAll());
  let reviewed = false;
  let held = false;
  let stop: Promise<RafiResult> | null = null;
  const owner = rafi.start("start . --steps 1", { pauseAt: {
    at: (o) => {
      if (o.startsWith("3: reply arrived, before it's recorded (T1, review, attempt 4")) reviewed = true;
      return reviewed && !held && o.startsWith("4: recorded") && (held = true);
    },
    fn: async () => {
      // The owner is alive with T1's last review recorded; stop decides that, then its write is busy, and meanwhile
      // the owner opens T1's question, waits (no terminal) and releases the build.
      let busy: () => void = () => undefined;
      const writing = new Promise<void>((r) => { busy = r; });
      computer.clock.whenTimer("backoff", async () => {
        busy();
        await until(() => count("build.owner_released") > 0, "the owner to release");
      });
      stop = rafi("stop", { faults: { busyAt: 1 } });
      await writing;
    } } });
  const o = await owner.done();
  assert.ok(stop, "stop ran while the owner was alive");
  const s = await (stop as Promise<RafiResult>);
  assert.match(o.output, /is waiting on question/, o.output);
  const types = rows("SELECT type FROM events ORDER BY seq").map((r) => String(r.type));
  assert.deepEqual(types.slice(types.lastIndexOf("build.owner_released") - 1),
    ["build.waiting", "build.owner_released", "build.stop_requested", "build.stopped"],
    `nothing left stopping with no owner:\n${s.output}`);
  assert.match(s.output, /Build \S+ stopped\. `rafi resume` continues it\./, s.output);
  assert.equal(s.code, 0, s.output);
});
