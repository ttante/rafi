import { chmodSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { createDisposableQaSnapshotAsync } from "../src/qaSnapshot.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

test("async disposable QA snapshot reproduces tracked, staged, binary, and untracked changes without mutating Builder state", async () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-qa-snapshot-test-"));
  try {
    git(root, "init", "-q");
    git(root, "config", "user.email", "qa@example.invalid");
    git(root, "config", "user.name", "QA Test");
    writeFileSync(join(root, ".gitignore"), "coverage/\n");
    writeFileSync(join(root, "tracked.txt"), "before\n");
    writeFileSync(join(root, "binary.dat"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(root, "renamed.txt"), "rename me\n");
    git(root, "add", "."); git(root, "commit", "-qm", "initial");

    writeFileSync(join(root, "tracked.txt"), "after\n");
    writeFileSync(join(root, "binary.dat"), Buffer.from([0, 255, 2, 9]));
    git(root, "mv", "renamed.txt", "moved.txt");
    writeFileSync(join(root, "tool.sh"), "#!/bin/sh\nexit 0\n"); chmodSync(join(root, "tool.sh"), 0o755);
    symlinkSync("tracked.txt", join(root, "link.txt"));
    git(root, "add", "tracked.txt", "moved.txt");

    const progress: string[] = [];
    const snapshot = await createDisposableQaSnapshotAsync(root, (state, detail) => progress.push(`${state}: ${detail ?? ""}`));
    try {
      assert.equal(readFileSync(join(snapshot.path, "tracked.txt"), "utf8"), "after\n");
      assert.deepEqual(readFileSync(join(snapshot.path, "binary.dat")), Buffer.from([0, 255, 2, 9]));
      assert.equal(readFileSync(join(snapshot.path, "moved.txt"), "utf8"), "rename me\n");
      assert.equal(lstatSync(join(snapshot.path, "tool.sh")).mode & 0o777, 0o755);
      assert.equal(readlinkSync(join(snapshot.path, "link.txt")), "tracked.txt");
      assert.deepEqual(await snapshot.qaChanges(), []);

      writeFileSync(join(snapshot.path, "tracked.txt"), "QA must not edit\n");
      assert.deepEqual(await snapshot.qaChanges(), ["tracked diff changed"]);
      assert.equal(readFileSync(join(root, "tracked.txt"), "utf8"), "after\n");
      assert.ok(progress.some((entry) => entry.includes("creating detached review worktree")));
      assert.ok(progress.some((entry) => entry.includes("checking QA file changes")));
    } finally {
      await snapshot.remove();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
