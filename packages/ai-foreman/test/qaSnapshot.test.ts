import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { captureStableFrozenQaSourceAsync, createDisposableQaSnapshotAsync, QaSourceInstabilityError, type FrozenQaSourceState } from "../src/qaSnapshot.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function frozen(digest: string): FrozenQaSourceState {
  return { head: "head", originDigest: "origin", contentDigest: "content", repository: { topLevel: "/repo", gitDir: "/repo/.git", commonDir: "/repo/.git", indexDigest: "", configDigest: "", refsDigest: "", sparseDigest: "", submoduleDigest: "" }, status: Buffer.alloc(0), combinedDiff: Buffer.alloc(0), stagedDiff: Buffer.alloc(0), unstagedDiff: Buffer.alloc(0), changeSummary: "", pathInventory: [], untracked: [], digest, capturedAt: "" };
}

test("stable source capture retries twice and accepts the third byte-identical pair", async () => {
  const seen: Array<[number, number]> = [];
  const result = await captureStableFrozenQaSourceAsync(async (attempt, pass) => {
    seen.push([attempt, pass]);
    return frozen(attempt < 3 ? `${attempt}-${pass}` : "stable");
  }, new Date("2026-01-01T00:00:00.000Z"));
  assert.equal(result.digest, "stable");
  assert.deepEqual(seen, [[1, 1], [1, 2], [2, 1], [2, 2], [3, 1], [3, 2]]);
});

test("stable source capture fails closed after all three pairs drift", async () => {
  await assert.rejects(captureStableFrozenQaSourceAsync(async (attempt, pass) => frozen(`${attempt}-${pass}`)), QaSourceInstabilityError);
});

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
      assert.ok(progress.some((entry) => entry.includes("creating independent review repository")));
      assert.ok(progress.some((entry) => entry.includes("checking QA file changes")));
    } finally {
      await snapshot.remove();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("async disposable QA snapshot supports an initialized repository with no commit", async () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-qa-no-head-test-"));
  try {
    git(root, "init", "-q");
    writeFileSync(join(root, ".gitignore"), "node_modules/\nvendor/\n");
    writeFileSync(join(root, "app.txt"), "builder source\n");
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "node_modules", "tool.txt"), "runtime dependency\n");
    mkdirSync(join(root, "vendor"), { recursive: true });
    writeFileSync(join(root, "vendor", "runtime.txt"), "ignored runtime\n");

    const snapshot = await createDisposableQaSnapshotAsync(root);
    try {
      assert.equal(snapshot.frozenState.head, "unavailable");
      assert.equal(readFileSync(join(snapshot.path, "app.txt"), "utf8"), "builder source\n");
      assert.equal(readFileSync(join(snapshot.path, "node_modules", "tool.txt"), "utf8"), "runtime dependency\n");
      assert.equal(readFileSync(join(snapshot.path, "vendor", "runtime.txt"), "utf8"), "ignored runtime\n");
      assert.deepEqual(await snapshot.qaChanges(), []);
      writeFileSync(join(snapshot.path, "app.txt"), "QA changed it\n");
      assert.deepEqual(await snapshot.qaChanges(), ["app.txt"]);
    } finally {
      await snapshot.remove();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("committed-repository QA snapshot projects ignored vendored checkouts without reporting them as QA edits", async () => {
  // Regression: MoneyTree's ignored vendor/starnet checkout was visible to QA
  // only while the project had no commit; after the first commit QA lost it.
  const root = mkdtempSync(join(tmpdir(), "rafi-qa-vendor-test-"));
  try {
    git(root, "init", "-q");
    git(root, "config", "user.email", "qa@example.invalid");
    git(root, "config", "user.name", "QA Test");
    writeFileSync(join(root, ".gitignore"), "vendor/\n");
    writeFileSync(join(root, "app.txt"), "builder source\n");
    git(root, "add", "."); git(root, "commit", "-qm", "initial");
    mkdirSync(join(root, "vendor", "upstream"), { recursive: true });
    git(join(root, "vendor", "upstream"), "init", "-q");
    writeFileSync(join(root, "vendor", "upstream", "README.md"), "pinned upstream\n");
    // Ignored only by this checkout's local exclude file, which a clone does not inherit.
    mkdirSync(join(root, "local-only"));
    writeFileSync(join(root, "local-only", "note.txt"), "local\n");
    writeFileSync(join(root, ".git", "info", "exclude"), "local-only/\n");

    const snapshot = await createDisposableQaSnapshotAsync(root);
    try {
      assert.notEqual(snapshot.frozenState.head, "unavailable");
      assert.equal(readFileSync(join(snapshot.path, "vendor", "upstream", "README.md"), "utf8"), "pinned upstream\n");
      assert.equal(existsSync(join(snapshot.path, "local-only")), false);
      assert.deepEqual(await snapshot.qaChanges(), []);
    } finally {
      await snapshot.remove();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
