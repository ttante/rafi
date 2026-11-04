// Item 16 (M3 plan, C118, C119, P25 B): the full fingerprint (a fresh index: links hashed by their text, never
// followed; ignored files not read), the QA copy at the snapshot's content, cleanup confined to the copy path, and
// no ref or index change. Real git in a temp repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync }
  from "node:fs";
import path from "node:path";
import { realFs, realGit } from "../../src/deps/real/index.js";
import { fullFingerprint } from "../../src/facts/fingerprint.js";
import { snapshot } from "../../src/facts/snapshot.js";
import { isolationFor, makeCopy, removeCopy } from "../../src/build/isolation.js";
import { tempDir } from "../helpers.js";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t" };
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
let n = 0;
const deps = { git: realGit, fs: realFs({ id: () => `t${++n}`, jitter: () => 0 } as never), env: {} };

function repo(): { dir: string; outside: string } {
  const dir = tempDir();
  const outside = path.join(tempDir(), "outside.txt");
  writeFileSync(outside, "outside\n");
  sh(dir, "init", "-q", "-b", "main");
  mkdirSync(path.join(dir, "src"));
  mkdirSync(path.join(dir, "ignored"));
  writeFileSync(path.join(dir, "src", "a.txt"), "aaaa\n");
  writeFileSync(path.join(dir, ".gitignore"), "ignored/\n");
  writeFileSync(path.join(dir, "ignored", "big.bin"), "x".repeat(10_000));
  symlinkSync("src/a.txt", path.join(dir, "inside-link"));
  symlinkSync(outside, path.join(dir, "outside-link"));
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "c");
  return { dir, outside };
}

test("the full fingerprint counts non-ignored files and bytes, and hashes links by their text", async () => {
  const { dir, outside } = repo();
  const a = await fullFingerprint(deps, dir, "t");
  assert.equal(a.files, 4, ".gitignore, src/a.txt and the two links; ignored/ isn't read");
  assert.ok(a.bytes > 0 && a.bytes < 1000, `${a.bytes} bytes`);
  writeFileSync(outside, "changed outside\n");
  assert.equal((await fullFingerprint(deps, dir, "t")).fp, a.fp, "a link's target isn't followed");
  writeFileSync(path.join(dir, "ignored", "big.bin"), "y");
  assert.equal((await fullFingerprint(deps, dir, "t")).fp, a.fp, "ignored files don't count");
  unlinkSync(path.join(dir, "outside-link"));
  symlinkSync("/etc/hosts", path.join(dir, "outside-link"));
  assert.notEqual((await fullFingerprint(deps, dir, "t")).fp, a.fp, "a retargeted link changes it");
  writeFileSync(path.join(dir, "src", "a.txt"), "aaab\n");
  const b = await fullFingerprint(deps, dir, "t");
  assert.notEqual(b.fp, a.fp);
  assert.equal(sh(dir, "status", "--porcelain").split("\n").filter(Boolean).length, 2, "the real index is untouched");
});

test("isolation: full for High risk or qa_isolation full, light otherwise, and why says which (P25 B)", () => {
  assert.deepEqual(isolationFor({ risk: "Low" }), { full: false, why: "light fingerprint" });
  assert.deepEqual(isolationFor({ risk: "High" }), { full: true, why: "full fingerprint (High risk)" });
  assert.deepEqual(isolationFor({ risk: "Low", qa_isolation: "full" }),
    { full: true, why: "full fingerprint (qa_isolation: full)" });
});

test("the copy holds the snapshot; cleanup removes only it; no ref, index or worktree is left changed", async () => {
  const { dir, outside } = repo();
  writeFileSync(path.join(dir, "src", "a.txt"), "the builder's work\n");
  const snap = await snapshot(deps, dir, "s");
  assert.ok(snap.ok);
  const refs = sh(dir, "for-each-ref");
  const head = sh(dir, "rev-parse", "HEAD");
  const index = readFileSync(path.join(dir, ".git", "index"));
  const copy = await makeCopy(deps, dir, snap.tree, "T1-1");
  assert.equal(copy, path.join(dir, ".rafi", "cache", "qa-copy", "T1-1"));
  assert.equal(readFileSync(path.join(copy, "src", "a.txt"), "utf8"), "the builder's work\n");
  assert.equal(sh(copy, "rev-parse", "HEAD^{tree}"), snap.tree);
  assert.equal(sh(dir, "worktree", "list").split("\n").length, 2);
  writeFileSync(path.join(copy, "src", "a.txt"), "QA's run changed this in the copy\n");
  await removeCopy(deps, dir, copy);
  assert.ok(!existsSync(copy));
  assert.equal(sh(dir, "worktree", "list").split("\n").length, 1);
  assert.equal(readFileSync(path.join(dir, "src", "a.txt"), "utf8"), "the builder's work\n", "your file");
  assert.equal(readFileSync(outside, "utf8"), "outside\n", "a link's target outside the project");
  assert.equal(sh(dir, "for-each-ref"), refs);
  assert.equal(sh(dir, "rev-parse", "HEAD"), head);
  assert.deepEqual(readFileSync(path.join(dir, ".git", "index")), index, "the real index");
  assert.equal(sh(dir, "status", "--porcelain"), "M src/a.txt");
});

test("cleanup refuses any path outside .rafi/cache/qa-copy/ before removing anything", async () => {
  const { dir } = repo();
  for (const bad of [dir, path.join(dir, "src"), path.join(dir, ".rafi", "cache"),
    path.join(dir, ".rafi", "cache", "qa-copy", "..", "x"), path.join(tempDir(), "qa-copy", "T1-1")]) {
    await assert.rejects(removeCopy(deps, dir, bad), /outside \.rafi\/cache\/qa-copy/, bad);
  }
  assert.ok(existsSync(path.join(dir, "src", "a.txt")));
});

test("review fix 1: a symlinked .rafi, cache or qa-copy folder is refused; nothing is made or removed outside",
  async () => {
    for (const linked of [".rafi", path.join(".rafi", "cache"), path.join(".rafi", "cache", "qa-copy")]) {
      const { dir } = repo();
      const snap = await snapshot(deps, dir, "s");
      assert.ok(snap.ok);
      const elsewhere = tempDir();
      rmSync(path.join(dir, ".rafi"), { recursive: true, force: true });
      mkdirSync(path.dirname(path.join(dir, linked)), { recursive: true });
      symlinkSync(elsewhere, path.join(dir, linked));
      await assert.rejects(makeCopy(deps, dir, snap.tree, "T1-1"), /symlink/, linked);
      assert.deepEqual(readdirSync(elsewhere), [], `${linked}: nothing made outside`);
      assert.equal(sh(dir, "worktree", "list").split("\n").length, 1, linked);
    }
    // A copy made in place, then its root swapped for a link to where the copy now lives: cleanup refuses.
    const { dir } = repo();
    const snap = await snapshot(deps, dir, "s");
    assert.ok(snap.ok);
    const copy = await makeCopy(deps, dir, snap.tree, "T1-1");
    const root = path.dirname(copy);
    const moved = path.join(tempDir(), "moved");
    renameSync(root, moved);
    symlinkSync(moved, root);
    await assert.rejects(removeCopy(deps, dir, copy), /symlink/);
    assert.ok(existsSync(path.join(moved, "T1-1", "src", "a.txt")), "the copy's target outside is untouched");
  });

test("threat 1: a copy a crash left at the same path is replaced, not reused, and cleanup still leaves one worktree",
  async () => {
    const { dir } = repo();
    const first = await snapshot(deps, dir, "s1");
    assert.ok(first.ok);
    await makeCopy(deps, dir, first.tree, "T1-1");
    writeFileSync(path.join(dir, "src", "a.txt"), "newer work\n");
    const second = await snapshot(deps, dir, "s2");
    assert.ok(second.ok);
    const copy = await makeCopy(deps, dir, second.tree, "T1-1");
    assert.equal(readFileSync(path.join(copy, "src", "a.txt"), "utf8"), "newer work\n");
    assert.equal(sh(dir, "worktree", "list").split("\n").length, 2);
    await removeCopy(deps, dir, copy);
    assert.equal(sh(dir, "worktree", "list").split("\n").length, 1);
  });
