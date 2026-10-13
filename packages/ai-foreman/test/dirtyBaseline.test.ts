import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureDirtyBaseline } from "../src/branch/dirtyBaseline.js";

for (const action of ["delete", "rename"] as const) test(`include honors staged ${action}`, () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-dirty-delete-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    git("init", "-q"); writeFileSync(join(root, "old.txt"), "original"); git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@test.local", "commit", "-qm", "seed");
    if (action === "delete") git("rm", "old.txt"); else git("mv", "old.txt", "new.txt");
    const index = readFileSync(join(root, ".git/index"));
    const { base } = captureDirtyBaseline(root, "include");
    assert.equal(git("ls-tree", "--name-only", base), action === "delete" ? "" : "new.txt");
    assert.deepEqual(readFileSync(join(root, ".git/index")), index);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const mode of ["preserve", "include"] as const) test(`dirty ${mode} captures input without changing checkout, index, or HEAD`, () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-dirty-input-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    git("init", "-q"); writeFileSync(join(root, "tracked.txt"), "committed"); git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@test.local", "commit", "-qm", "seed");
    const head = git("rev-parse", "HEAD");
    writeFileSync(join(root, "tracked.txt"), "staged"); git("add", "tracked.txt");
    writeFileSync(join(root, "tracked.txt"), "unstaged"); writeFileSync(join(root, "new.txt"), "untracked");
    const index = readFileSync(join(root, ".git/index"));
    const result = captureDirtyBaseline(root, mode);
    assert.equal(git("rev-parse", "HEAD"), head);
    assert.deepEqual(readFileSync(join(root, ".git/index")), index);
    assert.equal(readFileSync(join(root, "tracked.txt"), "utf8"), "unstaged");
    assert.equal(readFileSync(join(root, "new.txt"), "utf8"), "untracked");
    assert.equal(git("show", `${result.base}:tracked.txt`), mode === "include" ? "unstaged" : "committed");
    if (mode === "include") assert.equal(git("show", `${result.base}:new.txt`), "untracked");
    assert.equal(JSON.parse(readFileSync(join(result.recordPath, "manifest.json"), "utf8")).mode, mode);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("include can capture an unborn repository without creating its first user commit", () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-unborn-baseline-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    writeFileSync(join(root, "seed.txt"), "seed");
    assert.throws(() => captureDirtyBaseline(root, "preserve"), /no committed baseline.*include/);
    const { base } = captureDirtyBaseline(root, "include");
    assert.equal(execFileSync("git", ["show", `${base}:seed.txt`], { cwd: root, encoding: "utf8" }), "seed");
    assert.throws(() => execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, stdio: "ignore" }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
