// Item 21 (M4 plan 3.3, C154; FLAG-RE-1..3): reset's working-tree actions in a real git repo. Restart-current with
// stash (tracked changes stashed, an untracked folder byte-identical), discard (tracked changes restored, untracked
// untouched) and handled (nothing touched); archive-restart (the unfinished work committed on rafi/archive/<run>, no
// other ref moved, HEAD's files back at the base). A spy on git sees no push, --force, clean or remote command.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resetWorktree } from "../../src/git/reset.js";
import { tempDir, testGit } from "../helpers.js";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t" };
const sh = (dir: string, args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: ENV });

function repo() {
  const dir = tempDir();
  sh(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(dir, "a.txt"), "base\n");
  sh(dir, ["add", "-A"]);
  sh(dir, ["commit", "-qm", "base"]);
  writeFileSync(path.join(dir, "a.txt"), "unfinished\n");
  mkdirSync(path.join(dir, "notes"));
  writeFileSync(path.join(dir, "notes", "mine.md"), "my own notes\n");
  const calls: string[][] = [];
  const deps = { env: { PATH: process.env.PATH }, git: (args: string[], o: { cwd: string }) => {
    calls.push(args);
    return testGit(args, { ...o, env: { PATH: process.env.PATH ?? "" } });
  } };
  return { dir, deps, calls };
}

const refs = (dir: string) => sh(dir, ["for-each-ref", "--format=%(refname) %(objectname)"]).trim().split("\n");
const read = (dir: string, f: string) => readFileSync(path.join(dir, f), "utf8");
/** git's subcommand: the first argument that isn't an option or a `-c` value. */
const subcommand = (args: string[]) => args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-c");
const banned = (args: string[]) => ["push", "clean", "remote", "fetch", "pull"].includes(subcommand(args) ?? "") ||
  args.some((a) => a === "--force" || a === "-f" || a === "-D");

test("restart-current: stash keeps tracked changes in a stash, discard restores them, handled leaves them", async () => {
  for (const cleanup of ["stash", "discard", "handled"] as const) {
    const { dir, deps, calls } = repo();
    const out = await resetWorktree(deps, dir, { action: "restart-current", cleanup, run: "r1" });
    assert.equal(out.ok, true, `${cleanup}: ${JSON.stringify(out)}`);
    assert.equal(read(dir, "a.txt"), cleanup === "handled" ? "unfinished\n" : "base\n", cleanup);
    assert.equal(read(dir, "notes/mine.md"), "my own notes\n", `${cleanup}: the untracked folder is untouched`);
    if (cleanup === "stash") assert.match(sh(dir, ["stash", "list"]), /rafi reset r1/);
    assert.deepEqual(calls.filter(banned), [], cleanup);
  }
});

test("archive-restart: the work goes to rafi/archive/<run>; no other ref moves; the files are back at the base",
  async () => {
    const { dir, deps, calls } = repo();
    const before = refs(dir);
    const out = await resetWorktree(deps, dir, { action: "archive-restart", cleanup: null, run: "r7" });
    assert.equal(out.ok, true);
    assert.equal((out as { archive: string }).archive, "rafi/archive/r7");
    const after = refs(dir);
    assert.deepEqual(after.filter((r) => !r.startsWith("refs/heads/rafi/archive/r7 ")), before, "no other ref moved");
    assert.equal(sh(dir, ["show", "rafi/archive/r7:a.txt"]), "unfinished\n");
    assert.equal(read(dir, "a.txt"), "base\n");
    assert.equal(read(dir, "notes/mine.md"), "my own notes\n");
    assert.deepEqual(calls.filter(banned), []);
  });
