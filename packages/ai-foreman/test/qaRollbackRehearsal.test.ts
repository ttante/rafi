import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rehearseRollback } from "../src/qaRollbackRehearsal.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rafi-rollback-test-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test test.mjs" } }));
  writeFileSync(join(root, "test.mjs"), "import { test } from 'node:test'; test('passes', () => {});\n");
  writeFileSync(join(root, "value.txt"), "baseline\n");
  git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "baseline");
  writeFileSync(join(root, "value.txt"), "changed\n");
  return { root, git };
}

test("rollback rehearsal executes tests and reverts only its disposable clone", () => {
  const { root, git } = fixture();
  try {
    const before = git("status", "--porcelain").toString();
    const head = git("rev-parse", "HEAD").toString();
    const output = rehearseRollback(root);
    assert.match(output, /Rollback rehearsal passed/);
    assert.match(output.slice(0, 1000), /npm test before revert exited 0; git revert exited 0; npm test after revert exited 0; git diff --exit-code against captured HEAD exited 0/);
    assert.equal((output.match(/\$ npm test/g) ?? []).length, 2);
    assert.equal(readFileSync(join(root, "value.txt"), "utf8"), "changed\n");
    assert.equal(git("status", "--porcelain").toString(), before);
    assert.equal(git("rev-parse", "HEAD").toString(), head);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rollback rehearsal refuses untracked symlinks", { skip: process.platform === "win32" }, () => {
  const { root } = fixture();
  try {
    symlinkSync("/tmp", join(root, "outside"));
    assert.throws(() => rehearseRollback(root), /symbolic links/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rollback rehearsal refuses a tracked file changed into an external symlink", { skip: process.platform === "win32" }, () => {
  const { root } = fixture();
  try {
    rmSync(join(root, "value.txt"));
    symlinkSync("/tmp", join(root, "value.txt"));
    assert.throws(() => rehearseRollback(root), /symbolic links/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rollback rehearsal refuses Git environment redirection before touching a repository", () => {
  const { root } = fixture();
  const previous = process.env.GIT_INDEX_FILE;
  try {
    process.env.GIT_INDEX_FILE = join(root, "foreign-index");
    assert.throws(() => rehearseRollback(root), /Git repository overrides: GIT_INDEX_FILE/);
  } finally {
    if (previous === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollback rehearsal isolates and restores provider Git configuration", () => {
  const { root } = fixture();
  const keys = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"];
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  try {
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "core.bare";
    process.env.GIT_CONFIG_VALUE_0 = "true";
    assert.match(rehearseRollback(root), /Rollback rehearsal passed/);
    assert.equal(process.env.GIT_CONFIG_VALUE_0, "true");
  } finally {
    for (const key of keys) { const value = previous.get(key); if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollback rehearsal refuses a temp directory inside the source project", () => {
  const { root } = fixture();
  const previous = process.env.TMPDIR;
  try {
    process.env.TMPDIR = root;
    assert.throws(() => rehearseRollback(root), /temporary directory outside the source project/);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollback rehearsal requires the project root", () => {
  const { root } = fixture();
  try {
    mkdirSync(join(root, "nested"));
    assert.throws(() => rehearseRollback(join(root, "nested")), /project root/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a failed rehearsal leaves the original changes and Git state untouched", () => {
  const { root, git } = fixture();
  try {
    writeFileSync(join(root, "test.mjs"), "process.exit(1);\n");
    const before = git("status", "--porcelain").toString();
    const head = git("rev-parse", "HEAD").toString();
    let failure: unknown;
    let result: string | undefined;
    try { result = rehearseRollback(root); } catch (error) { failure = error; }
    assert.match(String(failure ?? result), /Rollback rehearsal failed: npm test/);
    assert.equal(git("status", "--porcelain").toString(), before);
    assert.equal(git("rev-parse", "HEAD").toString(), head);
    assert.equal(readFileSync(join(root, "test.mjs"), "utf8"), "process.exit(1);\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
