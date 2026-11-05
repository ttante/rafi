// Milestone: M5
// M5 plan 3.4's git races, part 1 (slice 5): R9 (the owner and its lease), R11 (trailer → commit), R12 (branch →
// create), R13 (remote tip → push), each forced at its lookup→act boundary with `onGit` (before rafi's own git
// call). Each asserts exactly one result and one result event; the mutations remove the compare-and-set (10.9).
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { git } from "../fixtures/common.js";
import { gitAs, remoteOf } from "../fixtures/f-branch.js";
import { T1, commitOnto, once, own, setup, trailers } from "./git-race-helpers.js";

/** Rafi's create call for T1's branch: `worktree add -b`, or `update-ref <ref> <new> <null id>` (part 6). */
const creates = (a: readonly string[]) => (a[0] === "worktree" && a.includes("-b")) ||
  (a[0] === "update-ref" && a.includes(`refs/heads/${T1}`) && /^0+$/.test(a.at(-1) ?? ""));

test("R11 (a): a commit with the same trailers lands first: rafi adopts it and makes none", async () => {
  const { project, rafi, exported, of } = setup();
  let theirs = "";
  const onGit = once((a) => {
    if (a[0] !== "update-ref" || !a.includes(`refs/heads/${T1}`) || creates(a)) return false;
    const [, , , , sha, parent] = a;
    const message = git(project, ["log", "-1", "--format=%B", sha!]);
    theirs = gitAs(project, ["commit-tree", `${sha}^{tree}`, "-p", parent!, "-m", message]).trim();
    git(project, ["update-ref", `refs/heads/${T1}`, theirs, parent!]);
    return true;
  });
  const r = await rafi("start . --steps 1 --branch-per-ticket", { onGit });
  assert.equal(r.code, 0, r.output);
  assert.deepEqual(trailers(project, T1, "T1"), [theirs], "one commit with T1's trailer: theirs");
  const e = await exported();
  assert.deepEqual(of(e, "git.committed").map((x) => (x.data as { sha: string }).sha), [theirs]);
});

test("R11 (b): an unrelated commit lands first: rafi commits on top of it, keeping its change", async () => {
  const { project, rafi, exported, of } = setup();
  let theirs = "";
  const onGit = once((a) => {
    if (a[0] !== "update-ref" || !a.includes(`refs/heads/${T1}`) || creates(a)) return false;
    theirs = commitOnto(project, a[5]!, "src/other.txt", "theirs\n");
    git(project, ["update-ref", `refs/heads/${T1}`, theirs, a[5]!]);
    return true;
  });
  const r = await rafi("start . --steps 1 --branch-per-ticket", { onGit });
  assert.equal(r.code, 0, r.output);
  const mine = trailers(project, T1, "T1");
  assert.equal(mine.length, 1);
  assert.equal(git(project, ["rev-parse", `${mine[0]}^`]).trim(), theirs, "rafi's commit is on top of theirs");
  assert.equal(git(project, ["show", `${T1}:src/other.txt`]), "theirs\n");
  assert.equal(git(project, ["show", `${T1}:src/T1.txt`]), "T1 done\n");
  assert.equal(of(await exported(), "git.committed").length, 1);
});

test("R12 (a): the branch appears at the planned base first: git's compare-and-set refuses; never used", async () => {
  // Part 6 (M5 review P1): a branch someone else made at the planned base is as foreign as any other; the race is
  // settled by git's create-only update, not by the tip's value.
  const { project, computer, rafi, exported, of } = setup({ build: { completion: "pr" } });
  const base = git(project, ["rev-parse", "HEAD"]).trim();
  const onGit = once((a) => {
    if (!creates(a)) return false;
    git(project, ["branch", T1, base]);
    return true;
  });
  const r = await rafi("start . --steps 1 --branch-per-ticket", { onGit });
  assert.match(r.output, /branch feature\/T1-add-the-parser already exists and isn't rafi's/);
  assert.equal(git(project, ["rev-parse", T1]).trim(), base, "no commit on it");
  assert.ok(!git(remoteOf(project), ["branch"]).includes(T1), "never pushed");
  const e = await exported();
  assert.deepEqual(of(e, "unit.failed").map((x) => (x.data as { category: string }).category), ["rejected"]);
  assert.equal(of(e, "git.branch_created").filter((x) => (x.data as { branch: string }).branch === T1).length, 0);
  assert.equal(computer.gh.prs.filter((p) => p.head === T1).length, 0);
});

test("R12 (b): a foreign branch of that name: the unit fails rejected; it's never reset or pushed", async () => {
  const { project, computer, rafi, exported, of } = setup({ build: { completion: "pr" } });
  let theirs = "";
  const onGit = once((a) => {
    if (!creates(a)) return false;
    theirs = gitAs(project, ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "mine"]).trim();
    git(project, ["branch", T1, theirs]);
    return true;
  });
  const r = await rafi("start . --steps 1 --branch-per-ticket", { onGit });
  assert.match(r.output, /branch feature\/T1-add-the-parser already exists and isn't rafi's/);
  assert.equal(git(project, ["rev-parse", T1]).trim(), theirs, "left as it was");
  assert.ok(!git(remoteOf(project), ["branch"]).includes(T1), "never pushed");
  const e = await exported();
  assert.deepEqual(of(e, "unit.failed").map((x) => (x.data as { category: string }).category), ["rejected"]);
  assert.equal(of(e, "git.branch_created").filter((x) => (x.data as { branch: string }).branch === T1).length, 0);
  assert.equal(computer.gh.prs.filter((p) => p.head === T1).length, 0);
});

test("R12 (c): a foreign branch already there before the build: refused at the lookup, left alone", async () => {
  const { project, rafi, exported, of } = setup();
  const theirs = gitAs(project, ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "mine"]).trim();
  git(project, ["branch", T1, theirs]);
  const r = await rafi("start . --steps 1 --branch-per-ticket");
  assert.match(r.output, /already exists and isn't rafi's/);
  assert.equal(git(project, ["rev-parse", T1]).trim(), theirs);
  assert.equal(of(await exported(), "git.intent").filter((x) => (x.data as { ref: string }).ref ===
    `refs/heads/${T1}`).length, 0, "no effect was even intended");
});

test("R12 (d): a foreign branch at the planned base before the build: refused, never committed to or pushed",
  async () => {
    const { project, computer, rafi, exported, of } = setup({ build: { completion: "pr" } });
    const base = git(project, ["rev-parse", "HEAD"]).trim();
    git(project, ["branch", T1, base]);
    const r = await rafi("start . --steps 1 --branch-per-ticket");
    assert.match(r.output, /branch feature\/T1-add-the-parser already exists and isn't rafi's/);
    assert.equal(git(project, ["rev-parse", T1]).trim(), base, "no commit on it");
    assert.ok(!git(remoteOf(project), ["branch"]).includes(T1), "never pushed");
    const e = await exported();
    assert.equal(of(e, "git.intent").filter((x) => (x.data as { ref: string }).ref === `refs/heads/${T1}`).length, 0);
    assert.equal(of(e, "git.branch_created").filter((x) => (x.data as { branch: string }).branch === T1).length, 0);
    assert.deepEqual(of(e, "unit.failed").map((x) => (x.data as { category: string }).category), ["rejected"]);
    assert.equal(computer.gh.prs.filter((p) => p.head === T1).length, 0);
  });

test("R12 (e): rafi made the branch and crashed before recording it (worktree gone): adopted on resume", async () => {
  const { project, rafi, exported, of } = setup();
  const crashed = await rafi("start . --steps 1 --branch-per-ticket", { crashAt: "6: after branch (T1" });
  assert.ok(crashed.crashed?.startsWith("6: after branch (T1"), crashed.output);
  const wt = git(project, ["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice(9)).find((p) => p.includes(".foreman"))!;
  git(project, ["worktree", "remove", "--force", wt]);
  const r = await rafi("resume");
  assert.equal(r.code, 0, r.output);
  assert.equal(of(await exported(), "git.branch_created").length, 1);
  assert.equal(trailers(project, T1, "T1").length, 1);
});

test("R12 (f): a dropped ticket's group was never made by rafi: a same-named branch of yours isn't pushed",
  async () => {
    const units = [{ id: "U1", tickets: ["T1", "T2"], branch_mode: "per-ticket" }, { id: "U2", tickets: ["T3", "T4"] }];
    const { project, rafi, exported, of } = setup({ units, build: { completion: "none" } });
    const T2 = "feature/T2-add-the-printer";
    const yours = gitAs(project, ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "yours"]).trim();
    git(project, ["branch", T2, yours]);
    assert.equal((await rafi("tickets cancel T2 --summary not-now")).code, 0);
    const r = await rafi("start . --steps 1 --branch-per-ticket --completion pr");
    assert.ok(!git(remoteOf(project), ["branch"]).includes(T2), `never pushed\n${r.output}`);
    assert.equal(git(project, ["rev-parse", T2]).trim(), yours, "left as it was");
    const e = await exported();
    assert.equal(of(e, "git.pushed").filter((x) => (x.data as { branch: string }).branch === T2).length, 0);
    assert.equal(r.code, 0, r.output);
    assert.equal(of(e, "unit.failed").length, 0, "the dropped ticket's group has nothing to deliver");
    assert.ok(git(remoteOf(project), ["branch"]).includes(T1), "T1's own branch is delivered");
  });

test("R12 (g): rafi crashed before its create and someone made the branch at the same commit: refused on resume",
  async () => {
    const { project, rafi, exported, of } = setup({ build: { completion: "pr" } });
    const crashed = await rafi("start . --steps 1 --branch-per-ticket", { crashAt: "6: before branch (T1" });
    assert.ok(crashed.crashed?.startsWith("6: before branch (T1"), crashed.output);
    const meant = of(await exported(), "git.intent").find((x) => (x.data as { ref: string }).ref ===
      `refs/heads/${T1}`)!.data as { new: string };
    git(project, ["branch", T1, meant.new]);
    const r = await rafi("resume");
    assert.match(r.output, /branch feature\/T1-add-the-parser already exists and isn't rafi's/);
    assert.equal(git(project, ["rev-parse", T1]).trim(), meant.new, "no commit on it");
    assert.ok(!git(remoteOf(project), ["branch"]).includes(T1), "never pushed");
    assert.equal(of(await exported(), "git.branch_created").filter((x) => (x.data as { branch: string }).branch ===
      T1).length, 0);
  });

test("R13 (a): the same commit is pushed first: rafi's push is up to date, one git.pushed", async () => {
  const { project, rafi, exported, of } = setup({ build: { completion: "pr" } });
  const seen: string[][] = [];
  const onGit = once((a) => {
    seen.push(a);
    if (a[0] !== "push" || !a.some((x) => x.includes(T1))) return false;
    gitAs(project, ["push", "-q", remoteOf(project), `refs/heads/${T1}:refs/heads/${T1}`]);
    return true;
  });
  const r = await rafi("start . --steps 1 --branch-per-ticket", { onGit: (a) => { seen.push(own(a)); onGit(a); } });
  assert.equal(r.code, 0, r.output);
  const pushed = of(await exported(), "git.pushed").filter((x) => (x.data as { branch: string }).branch === T1);
  assert.equal(pushed.length, 1);
  for (const a of seen.filter((x) => x[0] === "push")) {
    assert.ok(!a.some((x) => x === "--force" || x === "-f" || x.startsWith("+") || x === "--delete" ||
      x === "--mirror" || x === "--tags" || x.startsWith("--force")), a.join(" "));
  }
});

test("R13 (b): another commit is pushed first: no force; the unit fails rejected", async () => {
  const { project, rafi, exported, of } = setup({ build: { completion: "pr" } });
  const onGit = once((a) => {
    if (a[0] !== "push" || !a.some((x) => x.includes(T1))) return false;
    const other = gitAs(project, ["commit-tree", "main^{tree}", "-p", "main", "-m", "theirs"]).trim();
    gitAs(project, ["push", "-q", remoteOf(project), `${other}:refs/heads/${T1}`]);
    return true;
  });
  const r = await rafi("start . --steps 1 --branch-per-ticket", { onGit });
  assert.match(r.output, /refused \(rafi never force-pushes\)/);
  const e = await exported();
  assert.deepEqual(of(e, "unit.failed").map((x) => (x.data as { category: string }).category), ["rejected"]);
  assert.equal(of(e, "git.pushed").filter((x) => (x.data as { branch: string }).branch === T1).length, 0);
});

test("R9: rafi reset while the owner is paused before its push is refused; the push then happens once", async () => {
  const { project, rafi, exported, of } = setup({ build: { completion: "pr" } });
  let refused = "";
  const at = (o: string) => o.startsWith("6: before push") && o.includes(T1);
  const r = await rafi("start . --steps 1 --branch-per-ticket", { pauseAt: { at, fn: async () => {
    refused = (await rafi("reset --build --action restart-current --cleanup handled --yes")).output;
  } } });
  assert.equal(r.code, 0, r.output);
  assert.match(refused, /running|owned|live|is being built|still/i, refused);
  const pushes = of(await exported(), "git.pushed").filter((x) => (x.data as { branch: string }).branch === T1);
  assert.equal(pushes.length, 1);
  assert.equal(git(remoteOf(project), ["rev-parse", T1]).trim(), git(project, ["rev-parse", T1]).trim());
  assert.equal(of(await exported(), "build.reset").length, 0);
});

test("R9 (b): an owner that lost its lease makes no further effect: the next intent is refused", async () => {
  const { project, computer, rafi } = setup({ build: { completion: "pr" } });
  const r = await rafi("start . --steps 1 --branch-per-ticket", { pauseAt: { at: (o) => o.startsWith("6: after push") &&
    o.includes(T1), fn: () => {
    const db = new DatabaseSync(path.join(project, ".rafi", "state.sqlite3"));
    try { db.prepare("DELETE FROM lease").run(); } finally { db.close(); }
  } } });
  assert.notEqual(r.code, 0);
  assert.match(r.output, /isn't owned by this rafi any more; no git action was taken/);
  assert.equal(computer.gh.prs.length, 0, "no PR after the lease was lost");
});

