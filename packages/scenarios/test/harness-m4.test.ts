// Milestone: M4
// Item 24 (M4 plan 3.3): the harness pieces M4 adds. Slice 0: the fixture cache (C158) and the git-call cut.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { runCli } from "@rafi-ai/cli/next";
import { tempRoot } from "../fixtures/common.js";
import { fChain } from "../fixtures/f-chain.js";
import { fOne } from "../fixtures/f-one.js";
import { fixtureCache } from "../harness/fixture-cache.js";
import { harnessDeps } from "../harness/deps.js";
import { newComputer, rafiRunner } from "../harness/rafi.js";
import { fakeTerminal } from "../fakes/terminal.js";
import { B, on } from "../fakes/script/behaviors.js";
import { scriptEngine } from "../fakes/script/engine.js";
import { scriptUsed, type ScriptState } from "../harness/agents.js";

function tree(dir: string, base = dir, out: Record<string, string> = {}): Record<string, string> {
  for (const name of readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) tree(file, base, out);
    else out[path.relative(base, file)] = readFileSync(file).toString("base64");
  }
  return out;
}

test("slice 0: a fixture is built once per job and copied after; the copies are byte-identical", () => {
  // M5 part 4a-2: small files can share a process now, so F-ONE may already be cached; the second is a hit anyway.
  const a = fOne(tempRoot());
  const hits = fixtureCache.hits;
  const b = fOne(tempRoot());
  assert.equal(fixtureCache.hits, hits + 1, "the second F-ONE is a copy of the first");
  assert.deepEqual(tree(b), tree(a));
});

test("slice 0: the check step reuses the snapshot taken just before it (one git-call cut)", async () => {
  const root = tempRoot();
  const project = fChain(root);
  const computer = newComputer(root);
  const terminal = fakeTerminal({ tty: false });
  terminal.end();
  const instance = harnessDeps(computer, terminal, { cwd: project, instance: "count" });
  const git = instance.deps.git;
  let writeTrees = 0;
  (instance.deps as { git: typeof git }).git = (args, o) => {
    if (args[0] === "write-tree") writeTrees += 1;
    return git(args, o);
  };
  assert.equal(await runCli(["start", ".", "--steps", "1"], instance.deps), 0);
  instance.fence.closeAll();
  // F-CHAIN's T1: the builder's run_check (before, after), the builder's snapshot, the check step's listing
  // snapshot (reused as the step's tree, since no listing runs for npm test), QA's review and its after: six, not
  // seven.
  assert.equal(writeTrees, 6);
});

// Slice 1: crashAt (C156), the live handle, the commit bus (C139), awaited pause (P34), one numbering (C164),
// consumed rules per computer (C166).

test("slice 1: crashAt by number and by name; no Internal error is shown and nothing runs after it", async () => {
  const root = tempRoot();
  const computer = newComputer(root);
  const clean = await rafiRunner(computer, fOne(root))("start . --steps 1");
  assert.equal(clean.code, 0, clean.output);
  assert.ok(clean.passed.length > 5, clean.passed.join("\n"));
  const name = clean.passed.find((p) => p.startsWith("2: sent, before any reply (T1, build"))!;
  assert.ok(name, clean.passed.join("\n"));
  for (const at of [clean.passed.indexOf(name) + 1, "2: sent, before any reply (T1, build"]) {
    const dir = fOne(tempRoot());
    const rafi = rafiRunner(newComputer(path.dirname(dir)), dir);
    const r = await rafi("start . --steps 1", { crashAt: at });
    assert.equal(r.crashed, name);
    assert.doesNotMatch(r.output, /Internal error|fenced/);
    const types = (JSON.parse((await rafi("stats export")).out) as { events: { type: string }[] }).events
      .map((e) => e.type);
    assert.equal(types.at(-1), "turn.sent", "nothing was recorded after the crash point");
  }
});

test("slice 1: the live handle waits for output, takes typed lines, and returns the result", async () => {
  const root = tempRoot();
  const computer = newComputer(root);
  computer.script.rules.push(...[1, 2, 3, 4].map((n) => on(`qa T1#${n} @review`, B.reject({ 1: "not yet" }))));
  const rafi = rafiRunner(computer, fOne(root));
  const live = rafi.start("start . --steps 1", { tty: true });
  await live.expect(/What next\?/);
  live.send("3\n");
  await live.expect(/Record validation_result=failed/);
  live.send("2\n");
  const r = await live.done();
  assert.equal(r.code, 0, r.output);
});

test("slice 1: the commit bus tells other instances on the same database, never the committer", async () => {
  const root = tempRoot();
  const project = fOne(root);
  const computer = newComputer(root);
  const t = fakeTerminal({ tty: false });
  const a = harnessDeps(computer, t, { cwd: project, instance: "a" });
  const b = harnessDeps(computer, t, { cwd: project, instance: "b" });
  const file = path.join(project, "x.sqlite3");
  const seen: string[] = [];
  const stopA = a.deps.logChanged(file, () => seen.push("a"));
  const stopB = b.deps.logChanged(file, () => seen.push("b"));
  const db = b.deps.db.open(file);
  db.exec("BEGIN IMMEDIATE");
  db.exec("CREATE TABLE t (x)");
  db.exec("COMMIT");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, ["a"]);
  stopA();
  stopB();
  db.close();
});

test("slice 1: pause.at(k) is awaited at its boundary, and names the same occurrence as crash.at(k)", async () => {
  const root = tempRoot();
  const computer = newComputer(root);
  const clean = await rafiRunner(computer, fOne(root))("start . --steps 1");
  const k = clean.passed.findIndex((p) => p.startsWith("4: recorded")) + 1;
  assert.ok(k > 0);
  const dir = fOne(tempRoot());
  let held = "";
  let after = -1;
  const paused = await rafiRunner(newComputer(path.dirname(dir)), dir)("start . --steps 1", {
    pauseAt: { at: k, fn: async (occurrence, passed) => {
      held = occurrence;
      await new Promise((r) => setTimeout(r, 30));
      after = passed.length;
    } } });
  assert.equal(paused.code, 0, paused.output);
  assert.equal(held, clean.passed[k - 1]);
  assert.equal(after, k, "the engine waited at k: nothing after it was passed while the hook ran");
  const dir2 = fOne(tempRoot());
  const crashed = await rafiRunner(newComputer(path.dirname(dir2)), dir2)("start . --steps 1", { crashAt: k });
  assert.equal(crashed.crashed, held);
});

test("slice 1: a consumed rule stays consumed for the computer's next instance (C166)", () => {
  const state: ScriptState = { rules: [on("builder T1#1", B.hang())], transcript: [] };
  const first = scriptEngine(state.rules, undefined, scriptUsed(state));
  assert.equal(first.next({ role: "builder", ticket: "T1", attempt: 1 }).hang, true);
  const second = scriptEngine(state.rules, undefined, scriptUsed(state));
  assert.notEqual(second.next({ role: "builder", ticket: "T1", attempt: 1 }).hang, true);
});
