// Milestone: M3
// M3 plan section 4, the copy rows: QA's run_check in a copy runs there (cwd, sandbox worktree, restore); your
// worktree's files, HEAD, refs, the real index and `git worktree list` are as they were; the full fingerprint stays
// bounded on F-HUGE's ignored folder. Cleanup's symlink and path rules are in engine/test/build/isolation.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { realExec, realFs } from "@rafi-ai/engine/deps/real";
import { GIT_BINARY } from "../harness/deps.js";
import { fullFingerprint } from "@rafi-ai/engine/build";
import { B, on } from "../fakes/script/behaviors.js";
import type { Behavior, MetaLike, TurnContext } from "../fakes/script/engine.js";
import { git, setTickets, tempRoot } from "../fixtures/common.js";
import { fHuge } from "../fixtures/f-huge.js";
import { fTestsLocal } from "../fixtures/f-tests.js";
import { newComputer, rafiRunner } from "../harness/rafi.js";

test("a copy review's run_check runs in the copy and is restored there; your files and git state are untouched",
  async () => {
    const root = tempRoot();
    const project = fTestsLocal(root);
    setTickets(project, { T1: { risk: "High" } });
    const computer = newComputer(root);
    computer.checks.tests["t2.test"] = { outcomes: ["pass"], edits: "src/index.js" };
    const copyReview = (meta: MetaLike, ctx: TurnContext): Behavior => ({ ...B.pass()(meta, ctx),
      steps: [{ runCheck: "fake-test t2.test" }] });
    computer.script.rules.push(on("qa T1#1 @review", B.outside({ edit: "src/T1.txt", content: "yours\n" })),
      on("qa T1#1 @review", copyReview));
    const index = readFileSync(path.join(project, ".git", "index"));
    const head = git(project, ["rev-parse", "HEAD"]);
    const refs = git(project, ["for-each-ref"]);
    const yours = readFileSync(path.join(project, "src", "index.js"));
    const rafi = rafiRunner(computer, project);
    const r = await rafi("start . --ticket T1 --steps 1");
    assert.equal(r.code, 0, r.output);
    const copies = path.join(project, ".rafi", "cache", "qa-copy") + path.sep;
    const run = computer.checks.log.find((l) => l.args.includes("t2.test"))!;
    assert.ok(run.cwd.startsWith(copies), run.cwd);
    assert.ok(run.sandbox.some((a) => a.includes(run.cwd)), "the sandbox's worktree is the copy");
    const e = JSON.parse((await rafi("stats export")).out) as { events: { type: string; data: Record<string,
      unknown> }[] };
    const record = e.events.find((x) => x.type === "check.run" && x.data.asked_by === "qa")!.data;
    assert.deepEqual(record.restored, ["src/index.js"], "QA's run's edit was put back, in the copy");
    assert.deepEqual(readFileSync(path.join(project, "src", "index.js")), yours, "your file is byte-identical");
    assert.equal(readFileSync(path.join(project, "src", "T1.txt"), "utf8"), "yours\n");
    assert.deepEqual(readFileSync(path.join(project, ".git", "index")), index, "the real index");
    assert.equal(git(project, ["rev-parse", "HEAD"]), head);
    assert.equal(git(project, ["for-each-ref"]), refs);
    assert.equal(git(project, ["worktree", "list"]).trim().split("\n").length, 1);
    const sessions = computer.script.sessions!;
    const close = sessions.find((s) => s.op === "close" && s.cwd === run.cwd);
    assert.ok(close?.exists, "the copy's session closed before cleanup");
  });

test("the full fingerprint stays bounded on F-HUGE's ignored folder of 20,000 files", async () => {
  const dir = fHuge(tempRoot(), "ignored");
  let n = 0;
  const git = (args: string[], o: Parameters<typeof realExec>[2]) => realExec(GIT_BINARY, args, o);
  const deps = { git, fs: realFs({ id: () => `x${++n}`, jitter: () => 0 } as never), env: {} };
  const started = performance.now();
  const fp = await fullFingerprint(deps, dir, "huge");
  assert.ok(fp.files < 20, `${fp.files} files: the ignored folder isn't read`);
  assert.ok(performance.now() - started < 5000, "bounded");
});
