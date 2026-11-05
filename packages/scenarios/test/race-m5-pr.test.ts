// Milestone: M5
// M5 plan 3.4's git and PR races, part 2: R14 (no PR → create), R15 (the PR's state → an action), R16 (the base's
// tip → a direct merge), R17 (the scanned tree → the commit), forced with `onGit` or the fake gh's `onCall`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { git } from "../fixtures/common.js";
import { gitAs, remoteOf } from "../fixtures/f-branch.js";
import { openPr } from "../fakes/gh.js";
import { T1, once, setup } from "./git-race-helpers.js";

test("R14: a PR for the head is opened first: rafi adopts it; one PR, one pr.created", async () => {
  const { computer, rafi, exported, of } = setup({ build: { completion: "pr" } });
  let opened = "";
  computer.gh.onCall = (args, gh) => {
    if (args[0] === "pr" && args[1] === "create" && args.includes(T1) && !opened) {
      opened = openPr(gh, { head: T1, base: "main", draft: true }).url;
    }
  };
  const r = await rafi("start . --steps 1 --branch-per-ticket", {});
  assert.equal(r.code, 0, r.output);
  assert.equal(computer.gh.prs.filter((p) => p.head === T1).length, 1);
  const created = of(await exported(), "pr.created").filter((x) => (x.data as { branch: string }).branch === T1);
  assert.deepEqual(created.map((x) => (x.data as { url: string }).url), [opened]);
});

test("R17: a file staged between the scan and the commit never reaches it; the next scan holds it", async () => {
  const SECRET = "s3cr3t-value-123456";
  const units = [{ id: "U1", tickets: ["T1", "T2"], branch_mode: "shared" }];
  const { project, rafi, exported, of } = setup({ units, config: { checks: { env: ["TEST_API_KEY"] } } },
    { TEST_API_KEY: SECRET });
  const onGit = once((a) => {
    // The scan's first git call: the tree is written, the commit isn't made yet.
    if (a[0] !== "diff-tree") return false;
    const wt = path.join(project, ".foreman", "worktrees");
    const dir = path.join(wt, git(project, ["worktree", "list", "--porcelain"]).split("\n")
      .find((l) => l.startsWith("worktree ") && l.includes(".foreman"))!.slice(9).split(path.sep).at(-1)!);
    writeFileSync(path.join(dir, "late.txt"), `${SECRET}\n`);
    git(dir, ["add", "late.txt"]);
    return true;
  });
  const r = await rafi("start . --steps 2", { onGit, env: { TEST_API_KEY: SECRET } });
  assert.ok(of(await exported(), "delivery.done").some((x) => x.ticket_id === "T3"), "the rest goes on");
  const all = git(project, ["rev-list", "--all"]).split("\n").filter(Boolean);
  for (const c of all) assert.throws(() => git(project, ["grep", "-q", "-F", SECRET, c, "--"]), `${c} has it`);
  assert.match(r.output, /late\.txt contains the value of TEST_API_KEY; not committed/);
  assert.ok(!r.output.includes(SECRET));
  const e = await exported();
  assert.equal(of(e, "git.committed").length, 1, "T1 committed, T2 held");
  const held = of(e, "step.failed").filter((x) => x.ticket_id === "T2");
  assert.equal(held.length, 1);
  assert.ok(!JSON.stringify(e).includes(SECRET));
});

// Slice 6: R15 (the PR's state → an action on it) and R16 (the base's tip → a direct merge).
test("R15 (a): the PR merges before rafi turns auto-merge on: recorded merged once, no merge run", async () => {
  const { computer, rafi, exported, of } = setup({ build: { completion: "auto-merge" } });
  computer.gh.onCall = (args, gh) => {
    if (args[0] === "pr" && args[1] === "merge") for (const p of gh.prs) p.state = "MERGED";
  };
  const r = await rafi("start . --steps 1 --branch-per-ticket");
  assert.equal(r.code, 0, r.output);
  const e = await exported();
  assert.equal(of(e, "pr.merged").length, 1);
  assert.deepEqual(of(e, "unit.delivered").map((x) => (x.data as { how: string }).how), ["merged"]);
  assert.equal(of(e, "unit.merge_waiting").length, 0);
});

test("R15 (b): the PR is closed before auto-merge: the unit fails rejected; never reopened or recreated", async () => {
  const { computer, rafi, exported, of } = setup({ build: { completion: "auto-merge" } });
  computer.gh.onCall = (args, gh) => {
    if (args[0] === "pr" && args[1] === "merge") for (const p of gh.prs) p.state = "CLOSED";
  };
  const r = await rafi("start . --steps 1 --branch-per-ticket");
  assert.match(r.output, /was closed; rafi doesn't reopen or recreate it/);
  assert.equal(computer.gh.prs.length, 1, "no second PR");
  assert.ok(!computer.gh.calls.some((c) => c.args.includes("reopen")));
  assert.deepEqual(of(await exported(), "unit.failed").map((x) => (x.data as { category: string }).category),
    ["rejected"]);
});

/** You commit on main in your checkout while rafi is about to publish its merge. */
function youCommit(project: string, file: string, content: string): void {
  writeFileSync(path.join(project, file), content);
  git(project, ["add", "--", file]);
  gitAs(project, ["commit", "-qm", `you: ${file}`]);
}

test("R16 (a): main moves before the direct merge publishes: merged again from the new tip; yours kept", async () => {
  const { project, rafi, exported, of } = setup({ build: { completion: "direct-merge" } });
  const onGit = once((a) => {
    if (a[0] !== "merge" || !a.includes("--ff-only")) return false;
    youCommit(project, "NOTES.md", "mine\n");
    return true;
  });
  const r = await rafi("start . --steps 1 --branch-per-ticket", { onGit });
  assert.equal(r.code, 0, r.output);
  assert.match(git(project, ["log", "--format=%s", "main"]), /you: NOTES\.md/);
  git(project, ["merge-base", "--is-ancestor", T1, "main"]);
  assert.equal(of(await exported(), "unit.delivered").length, 1);
  assert.equal(git(remoteOf(project), ["rev-parse", "main"]).trim(), git(project, ["rev-parse", "main"]).trim());
});

test("R16 (b): main changes the same lines first: the redo conflicts; unit.failed conflict", async () => {
  const { project, rafi, exported, of } = setup({ build: { completion: "direct-merge" } });
  const onGit = once((a) => {
    if (a[0] !== "merge" || !a.includes("--ff-only")) return false;
    youCommit(project, "src/T1.txt", "yours\n");
    return true;
  });
  const r = await rafi("start . --steps 1 --branch-per-ticket", { onGit });
  assert.notEqual(r.code, 0);
  assert.match(r.output, /conflicts in src\/T1\.txt/);
  assert.deepEqual(of(await exported(), "unit.failed").map((x) => (x.data as { category: string }).category),
    ["conflict"]);
  assert.equal(git(project, ["show", "main:src/T1.txt"]), "yours\n", "your commit stays; nothing half-merged");
});
