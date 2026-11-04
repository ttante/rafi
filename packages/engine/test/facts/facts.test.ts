// Item 23 (M2 plan 3.3): the worktree snapshot (ARCH 4.7) from a temporary index under .rafi/cache/, changed
// files, ignored folders skipped, the real index untouched, "no commit yet"; run numbers per ticket.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { realFs } from "../../src/deps/real/index.js";
import { snapshot } from "../../src/facts/snapshot.js";
import { mismatches, nextRun } from "../../src/facts/runs.js";
import { tempDir, testGit } from "../helpers.js";

const env = { PATH: process.env.PATH, HOME: process.env.HOME, GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@b",
  GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@b" };
const deps = { git: testGit, fs: realFs({ id: () => "t", jitter: () => 0 }), env };
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

function repo(): string {
  const dir = tempDir();
  sh(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "a.txt"), "a\n");
  writeFileSync(path.join(dir, ".gitignore"), "big/\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "one");
  return dir;
}

test("the tree id equals git write-tree of the same content; changed files are listed", async () => {
  const dir = repo();
  writeFileSync(path.join(dir, "a.txt"), "changed\n");
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "src", "T1.txt"), "T1\n");
  const snap = await snapshot(deps, dir);
  assert.ok(snap.ok);
  const copy = tempDir();
  execFileSync("cp", ["-R", `${dir}/.`, copy]);
  sh(copy, "add", "-A");
  assert.equal(snap.ok && snap.tree, sh(copy, "write-tree"));
  assert.equal(snap.ok && snap.base, sh(dir, "rev-parse", "HEAD^{tree}"));
  assert.deepEqual(snap.ok && snap.files, ["a.txt", "src/T1.txt"]);
});

test("ignored folders and rafi's own folder aren't read or listed; the real index is untouched", async () => {
  const dir = repo();
  mkdirSync(path.join(dir, "big"));
  for (let i = 0; i < 50; i += 1) writeFileSync(path.join(dir, "big", `f${i}`), "x");
  mkdirSync(path.join(dir, ".rafi", "cache"), { recursive: true });
  writeFileSync(path.join(dir, ".rafi", "state.sqlite3"), "db");
  const index = readFileSync(path.join(dir, ".git", "index"));
  const snap = await snapshot(deps, dir);
  assert.ok(snap.ok);
  assert.deepEqual(snap.ok && snap.files, []);
  assert.equal(snap.ok && snap.tree, snap.ok && snap.base);
  assert.deepEqual(readFileSync(path.join(dir, ".git", "index")), index, "the real index is unchanged");
  assert.equal(sh(dir, "status", "--porcelain", "--untracked-files=all", "--", "a.txt"), "");
});

test("a repo with no commit yet is reported, not a crash", async () => {
  const dir = tempDir();
  sh(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "a.txt"), "a\n");
  const snap = await snapshot(deps, dir);
  assert.deepEqual(snap, { ok: false, noCommit: true });
});

test("run numbers count up per ticket; a cited run that failed is a mismatch, not a retry", () => {
  const events = [
    { type: "check.run", ticket_id: "T1", data: { run: 1, ticket: "T1", command: "npm test", outcome: "passed",
      exit_code: 0 } },
    { type: "check.run", ticket_id: "T2", data: { run: 1, ticket: "T2", command: "npm test", outcome: "failed",
      exit_code: 1 } },
    { type: "check.run", ticket_id: "T1", data: { run: 2, ticket: "T1", command: "npm test", outcome: "failed",
      exit_code: 1 } },
  ];
  assert.equal(nextRun(events, "T1"), 3);
  assert.equal(nextRun(events, "T3"), 1);
  assert.deepEqual(mismatches(events, "T1", { kind: "done", runs: [1, 2] }),
    [{ claim: "run 2 cited as evidence the work is done", record: "run 2 `npm test` failed (exit 1)" }]);
});

test("M4: with a heads cache, HEAD's tree is asked once per commit, and a new commit is seen", async () => {
  const dir = tempDir();
  sh(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "a.txt"), "1\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "one");
  let asked = 0;
  const counting = { ...deps, git: (args: string[], o: { cwd: string }) => {
    if (args[0] === "rev-parse") asked += 1;
    return testGit(args, { ...o, env });
  } };
  const heads = new Map<string, string>();
  const first = await snapshot(counting, dir, "a", { heads });
  await snapshot(counting, dir, "b", { heads });
  assert.equal(asked, 1, "the second snapshot read HEAD's tree from the cache");
  writeFileSync(path.join(dir, "a.txt"), "2\n");
  sh(dir, "commit", "-qam", "two");
  const third = await snapshot(counting, dir, "c", { heads });
  assert.ok(first.ok && third.ok);
  assert.equal(third.base, sh(dir, "rev-parse", "HEAD^{tree}"), "the new commit's tree");
  assert.notEqual(third.base, first.base);
  assert.deepEqual(third.files, []);
});
