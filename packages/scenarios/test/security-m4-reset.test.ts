// Milestone: M4
// M4 plan section 4, "Reset destroys your work" (FLAG-RE-3, ARCH 1.2): reset refuses while a build has a live owner
// and writes nothing; a reset of a crashed build only appends (the earlier log is unchanged); untracked files stay
// byte-identical; no push, force-push, clean or remote command (the git spy is in engine/test/git/reset.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { EventsExport } from "../checks/invariants.js";
import { B, on } from "../fakes/script/behaviors.js";
import { tempRoot } from "../fixtures/common.js";
import { fOne } from "../fixtures/f-one.js";
import { newComputer, rafiRunner } from "../harness/rafi.js";

function setup() {
  const root = tempRoot();
  const project = fOne(root);
  const computer = newComputer(root);
  const rafi = rafiRunner(computer, project);
  const exported = async () => JSON.parse((await rafi("stats export")).out) as EventsExport;
  return { project, computer, rafi, exported };
}

test("reset refuses while a build has a live owner, and writes nothing", async () => {
  const { computer, rafi, exported } = setup();
  computer.script.rules.push(on("builder T1#1 @build", B.slow(2)));
  const owner = rafi.start("start . --steps 1", { tty: true });
  let refused = null as Awaited<ReturnType<typeof rafi>> | null;
  let counts: number[] = [];
  computer.clock.whenTimer("agent", async () => {
    const before = (await exported()).events.length;
    refused = await rafi("reset --build --action restart-current --cleanup discard --yes");
    counts = [before, (await exported()).events.length];
  });
  assert.equal((await owner.done()).code, 0);
  assert.equal(refused!.code, 1);
  assert.match(refused!.output, /running; reset changes nothing while a build runs/);
  assert.equal(counts[1], counts[0]);
});

test("a reset of a crashed build only appends; untracked files stay byte-identical with discard", async () => {
  const { project, rafi, exported } = setup();
  const crashed = await rafi("start . --steps 1", { crashAt: "2: sent, before any reply (T1, build" });
  assert.ok(crashed.crashed);
  mkdirSync(path.join(project, "notes"));
  writeFileSync(path.join(project, "notes", "mine.md"), "my notes\n");
  writeFileSync(path.join(project, "README.md"), "edited by me\n");
  const before = (await exported()).events;
  const r = await rafi("reset --build --action restart-current --cleanup discard --yes");
  assert.equal(r.code, 0, r.output);
  const after = (await exported()).events;
  assert.deepEqual(after.slice(0, before.length), before, "the earlier log is unchanged");
  assert.deepEqual(after.slice(before.length).map((e) => e.type), ["build.reset"]);
  assert.equal(readFileSync(path.join(project, "notes", "mine.md"), "utf8"), "my notes\n");
  assert.equal(readFileSync(path.join(project, "README.md"), "utf8"), "# Fixture\n", "tracked files restored");
});
