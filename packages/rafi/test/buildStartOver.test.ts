import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBuildRun, releaseBuildLease } from "ai-foreman/build-runs.js";
import { applyStartOverGit, inventoryBuildStartOver, planStartOverGit } from "../src/buildStartOver.js";

function git(cwd: string, args: string[]): string { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }

test("local start-over archives commits and dirty work, reports branch, and restores original baseline", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-start-over-"));
  try {
    git(dir, ["init", "-b", "main"]); git(dir, ["config", "user.email", "test@example.test"]); git(dir, ["config", "user.name", "Test"]);
    writeFileSync(join(dir, "app.txt"), "baseline\n"); git(dir, ["add", "app.txt"]); git(dir, ["commit", "-m", "baseline"]);
    const baseline = git(dir, ["rev-parse", "HEAD"]);
    let run = createBuildRun({ repositoryRoot: dir, tickets: ["T001"], baseRef: "main" });
    run = releaseBuildLease(dir, run, "recoverable");
    writeFileSync(join(dir, "app.txt"), "committed work\n"); git(dir, ["add", "app.txt"]); git(dir, ["commit", "-m", "work"]);
    writeFileSync(join(dir, "extra.txt"), "dirty work\n");
    const inventory = inventoryBuildStartOver(dir, { ...run, active: false });
    assert.equal(inventory.recommended, "archive-restart");
    const planned = planStartOverGit(inventory, "archive-restart");
    const result = applyStartOverGit(inventory, "archive-restart", planned);
    assert.match(result.archiveBranch!, /^archive\/main-/);
    assert.equal(git(dir, ["branch", "--show-current"]), "main");
    assert.equal(git(dir, ["rev-parse", "HEAD"]), baseline);
    assert.equal(readFileSync(join(dir, "app.txt"), "utf8"), "baseline\n");
    assert.equal(git(dir, ["show", `${result.archiveBranch}:extra.txt`]), "dirty work");
    assert.deepEqual(applyStartOverGit(inventory, "archive-restart", planned), result);
    assert.equal(git(dir, ["branch", "--list", "archive/*"]).split("\n").filter(Boolean).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("legacy incomplete baseline offers archive/preserve and restarts from the detected current base without rewriting the original", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-start-over-legacy-"));
  try {
    git(dir, ["init", "-b", "main"]); git(dir, ["config", "user.email", "test@example.test"]); git(dir, ["config", "user.name", "Test"]);
    writeFileSync(join(dir, "app.txt"), "baseline\n"); git(dir, ["add", "app.txt"]); git(dir, ["commit", "-m", "baseline"]);
    git(dir, ["switch", "-c", "feature/legacy"]);
    writeFileSync(join(dir, "app.txt"), "committed legacy work\n"); git(dir, ["add", "app.txt"]); git(dir, ["commit", "-m", "legacy work"]);
    const originalHead = git(dir, ["rev-parse", "HEAD"]);
    let run = createBuildRun({ repositoryRoot: dir, tickets: ["T001"] }); run = releaseBuildLease(dir, run, "recoverable");
    run = { ...run, repository: { ...run.repository, baselineComplete: false, git: { ...run.repository.git, baselineHead: undefined, baseRef: undefined } } };
    writeFileSync(join(dir, "extra.txt"), "uncommitted legacy work\n");
    const inventory = inventoryBuildStartOver(dir, { ...run, active: false });
    assert.deepEqual(inventory.choices, ["archive-new-branch", "new-branch", "manual", "cancel"]);
    assert.equal(inventory.choices.includes("archive-restart"), false);
    assert.equal(inventory.baseRef, "main");
    assert.equal(inventory.recommended, "archive-new-branch");
    const result = applyStartOverGit(inventory, "archive-new-branch");
    assert.match(result.archiveBranch!, /^archive\/feature-legacy-/);
    assert.equal(git(dir, ["show", `${result.archiveBranch}:extra.txt`]), "uncommitted legacy work");
    assert.equal(git(dir, ["rev-parse", "feature/legacy"]), originalHead);
    assert.equal(git(dir, ["rev-parse", "HEAD"]), git(dir, ["rev-parse", "main"]));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("merged work exposes retain, reviewable revert, manual, and cancel choices", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-start-over-merged-"));
  try {
    git(dir, ["init", "-b", "main"]); git(dir, ["config", "user.email", "test@example.test"]); git(dir, ["config", "user.name", "Test"]);
    writeFileSync(join(dir, "app.txt"), "baseline\n"); git(dir, ["add", "app.txt"]); git(dir, ["commit", "-m", "baseline"]);
    const baseline = git(dir, ["rev-parse", "HEAD"]);
    git(dir, ["switch", "-c", "feature/merged"]);
    let run = createBuildRun({ repositoryRoot: dir, tickets: ["T001"], baseRef: "main", baseHead: baseline }); run = releaseBuildLease(dir, run, "recoverable");
    writeFileSync(join(dir, "app.txt"), "merged work\n"); git(dir, ["add", "app.txt"]); git(dir, ["commit", "-m", "work"]);
    const runHead = git(dir, ["rev-parse", "HEAD"]);
    git(dir, ["switch", "main"]); git(dir, ["merge", "--ff-only", "feature/merged"]); git(dir, ["switch", "feature/merged"]);
    run = { ...run, repository: { ...run.repository, git: { ...run.repository.git, startHead: runHead } } };
    const inventory = inventoryBuildStartOver(dir, { ...run, active: false });
    assert.equal(inventory.merged, true);
    assert.deepEqual(inventory.choices, ["retain-merged", "revert-branch", "manual", "cancel"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("pushed work is left on the original branch and restarts on a collision-safe new branch", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-start-over-pushed-"));
  try {
    git(dir, ["init", "-b", "main"]); git(dir, ["config", "user.email", "test@example.test"]); git(dir, ["config", "user.name", "Test"]);
    writeFileSync(join(dir, "app.txt"), "baseline\n"); git(dir, ["add", "app.txt"]); git(dir, ["commit", "-m", "baseline"]);
    const baseline = git(dir, ["rev-parse", "HEAD"]);
    let run = createBuildRun({ repositoryRoot: dir, tickets: ["T001"], baseRef: "main" }); run = releaseBuildLease(dir, run, "recoverable");
    writeFileSync(join(dir, "app.txt"), "pushed work\n"); git(dir, ["add", "app.txt"]); git(dir, ["commit", "-m", "work"]);
    const oldHead = git(dir, ["rev-parse", "HEAD"]);
    git(dir, ["branch", "main-restart-2", baseline]);
    run = { ...run, repository: { ...run.repository, git: { ...run.repository.git, upstream: "origin/main" } } };
    const inventory = inventoryBuildStartOver(dir, { ...run, active: false });
    assert.equal(inventory.recommended, "new-branch");
    const result = applyStartOverGit(inventory, "new-branch");
    assert.equal(result.restartBranch, "main-restart-3");
    assert.equal(git(dir, ["rev-parse", "main"]), oldHead);
    assert.equal(git(dir, ["rev-parse", "HEAD"]), baseline);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("dirty work on a pushed branch is classified as unexpected and must be moved first", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-start-over-pushed-dirty-"));
  try {
    git(dir, ["init", "-b", "main"]); git(dir, ["config", "user.email", "test@example.test"]); git(dir, ["config", "user.name", "Test"]);
    writeFileSync(join(dir, "app.txt"), "baseline\n"); git(dir, ["add", "app.txt"]); git(dir, ["commit", "-m", "baseline"]);
    let run = createBuildRun({ repositoryRoot: dir, tickets: ["T001"], baseRef: "main" }); run = releaseBuildLease(dir, run, "recoverable");
    run = { ...run, repository: { ...run.repository, git: { ...run.repository.git, upstream: "origin/main" } } };
    writeFileSync(join(dir, "dirty.txt"), "do not sweep\n");
    const inventory = inventoryBuildStartOver(dir, { ...run, active: false });
    assert.deepEqual(inventory.unexpectedPaths, ["dirty.txt"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
