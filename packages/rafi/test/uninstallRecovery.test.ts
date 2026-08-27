import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  capturePreimage, cleanupUninstallRecovery, finalizeOwnedWrite, initializeInstallManifest,
  preservePreimagesForLaterRestore, readInstallManifest, removeManagedBlocksTransaction, removeOwnedPathsTransaction,
  restoreUninstallRecovery,
} from "../src/ownership.js";
import { buildUninstallPlan, formatPreimageDiff } from "../src/uninstall.js";

test("version-2 ownership records Git baseline category and exact preimage", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-ownership-v2-"));
  try {
    writeFileSync(join(dir, "README.md"), "before\n");
    initializeInstallManifest(dir, "snapshot-and-continue");
    const entry = capturePreimage(dir, "README.md", "docs:readme", "documentation-modified");
    writeFileSync(join(dir, "README.md"), "after\n");
    finalizeOwnedWrite(dir, entry);
    const manifest = readInstallManifest(dir)!;
    assert.equal(manifest.version, 2);
    assert.equal(manifest.repository.dirtyChoice, "snapshot-and-continue");
    assert.equal(manifest.files[0]?.category, "documentation-modified");
    assert.ok(manifest.files[0]?.backup);
    assert.equal(readFileSync(join(dir, manifest.files[0]!.backup!), "utf8"), "before\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("uninstall removal keeps an indefinite payload and restore backs up collisions", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-uninstall-recovery-"));
  try {
    writeFileSync(join(dir, "owned.txt"), "owned\n");
    const removed = removeOwnedPathsTransaction(dir, ["owned.txt"]);
    assert.equal(existsSync(join(dir, "owned.txt")), false);
    assert.equal(readFileSync(join(dir, ".rafi-uninstall", removed.recoveryId, "payload", "owned.txt"), "utf8"), "owned\n");
    let restored = restoreUninstallRecovery(dir, removed.recoveryId);
    assert.deepEqual(restored.restored, ["owned.txt"]);
    assert.equal(readFileSync(join(dir, "owned.txt"), "utf8"), "owned\n");
    writeFileSync(join(dir, "owned.txt"), "newer\n");
    restored = restoreUninstallRecovery(dir, removed.recoveryId, undefined, false);
    assert.deepEqual(restored.collisions, ["owned.txt"]);
    restored = restoreUninstallRecovery(dir, removed.recoveryId, undefined, true);
    assert.ok(restored.backupId);
    assert.equal(readFileSync(join(dir, ".rafi-uninstall", restored.backupId!, "payload", "owned.txt"), "utf8"), "newer\n");
    assert.deepEqual(cleanupUninstallRecovery(dir, [removed.recoveryId]), [removed.recoveryId]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("managed-block uninstall removes only Rafi markers and preserves user text", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-uninstall-marker-"));
  try {
    writeFileSync(join(dir, ".gitignore"), "user.log\n# rafi:start\n.foreman/\n# rafi:end\nkeep.tmp\n");
    const result = removeManagedBlocksTransaction(dir, [{
      path: ".gitignore", sha256: null, mode: "managed-block", origin: "test", category: "managed-gitignore", marker: "# rafi:start..# rafi:end",
    }]);
    assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "user.log\nkeep.tmp\n");
    assert.equal(readFileSync(join(dir, ".rafi-uninstall", result.recoveryId, "payload", ".gitignore"), "utf8").includes(".foreman/"), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("legacy version-1 manifests upgrade in memory with explicit incomplete ownership metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-ownership-v1-"));
  try {
    mkdirSync(join(dir, ".rafi"));
    writeFileSync(join(dir, ".rafi", "install-manifest.json"), JSON.stringify({ version: 1, createdAt: "old", updatedAt: "old", files: [{ path: "README.md", sha256: null, mode: "created", origin: "legacy" }], dependencies: [] }));
    const manifest = readInstallManifest(dir)!;
    assert.equal(manifest.version, 2);
    assert.equal(manifest.repository.baselineComplete, false);
    assert.equal(manifest.repository.dirtyChoice, "legacy-unknown");
    assert.equal(manifest.files[0]?.category, "documentation-created");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("mixed post-install edits require path-specific handling and kept docs retain a later restore bundle", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-uninstall-mixed-"));
  try {
    writeFileSync(join(dir, "README.md"), "original\n");
    initializeInstallManifest(dir, "snapshot-and-continue");
    const preimage = capturePreimage(dir, "README.md", "docs", "documentation-modified");
    writeFileSync(join(dir, "README.md"), "Rafi section\n");
    finalizeOwnedWrite(dir, preimage);
    writeFileSync(join(dir, "README.md"), "Rafi section\nuser addition\n");
    const entry = readInstallManifest(dir)!.files[0]!;
    const plan = buildUninstallPlan(dir, [{ category: "documentation-modified", action: "restore", fileActions: { "README.md": "keep" } }]);
    assert.deepEqual(plan.restore, []);
    assert.deepEqual(plan.laterRestore, ["README.md"]);
    assert.match(formatPreimageDiff(dir, entry), /-original|\+Rafi section/);
    const later = preservePreimagesForLaterRestore(dir, [entry])!;
    const preview = restoreUninstallRecovery(dir, later.recoveryId, ["README.md"], false);
    assert.deepEqual(preview.collisions, ["README.md"]);
    restoreUninstallRecovery(dir, later.recoveryId, ["README.md"], true);
    assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "original\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
