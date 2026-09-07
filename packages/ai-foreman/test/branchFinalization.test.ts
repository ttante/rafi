import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeDirectMerge, prepareDirectMerge, reconcileDirectMerge, removeDirectMergeWorktree, verifyDirectMergeWorktree } from "../src/branch/finalization.js";
import { mergeBranchToLocalBase, runGit } from "../src/branch/git.js";
import { beginQaFinalization } from "../src/qaReview.js";
import { captureFrozenQaSourceAsync } from "../src/qaSnapshot.js";
import { WorkflowDb } from "../src/workflowDb.js";
import { runBranchPlan } from "../src/branch/runner.js";
import { Log } from "../src/log.js";
import { cmdInit } from "../src/tickets/commands.js";
import { saveTickets } from "../src/tickets/ticketLoader.js";
import type { TicketDef } from "../src/tickets/ticketSchema.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rafi-direct-merge-test-"));
  const project = join(root, "project");
  const worktree = join(root, "ticket");
  runGit(root, ["init", "-b", "main", project]);
  runGit(project, ["config", "user.name", "Test"]);
  runGit(project, ["config", "user.email", "test@example.test"]);
  writeFileSync(join(project, "base.txt"), "original\n");
  runGit(project, ["add", "."]);
  runGit(project, ["commit", "-m", "initial"]);
  runGit(project, ["worktree", "add", "-b", "ticket/T1", worktree]);
  writeFileSync(join(worktree, "ticket.txt"), "reviewed implementation\n");
  runGit(worktree, ["add", "."]);
  runGit(worktree, ["commit", "-m", "ticket"]);
  // A merge result must include independent base changes, not just the ticket tree.
  writeFileSync(join(project, "other-ticket.txt"), "independent base change\n");
  runGit(project, ["add", "."]);
  runGit(project, ["commit", "-m", "advance base"]);
  return { root, project, worktree };
}

for (const method of ["squash", "merge", "rebase"] as const) {
  test(`direct ${method} merge reconciles a crash before its receipt with an independently advanced base`, () => {
    const f = fixture();
    try {
      const intent = prepareDirectMerge(f.project, "T1", "ticket/T1", "main", method);
      assert.notEqual(intent.expectedTree, runGit(f.worktree, ["rev-parse", "HEAD^{tree}"]).stdout);
      assert.equal(reconcileDirectMerge(f.project, intent), undefined);
      // Git completes, then the host crashes without recording the receipt.
      mergeBranchToLocalBase(f.project, intent.branch, intent.base, "deliver T1", method);
      const completed = reconcileDirectMerge(f.project, intent);
      assert.equal(completed, runGit(f.project, ["rev-parse", "main"]).stdout);
      assert.equal(executeDirectMerge(f.project, intent, "must not make a second commit"), completed);
      assert.equal(verifyDirectMergeWorktree(f.project, intent), f.worktree);
      assert.equal(readFileSync(join(f.project, "ticket.txt"), "utf8"), "reviewed implementation\n");
      assert.equal(readFileSync(join(f.project, "other-ticket.txt"), "utf8"), "independent base change\n");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

test("direct merge preserves dirty worktrees after publication and rejects changed source before publication", () => {
  const f = fixture();
  try {
    const intent = prepareDirectMerge(f.project, "T1", "ticket/T1", "main", "squash");
    writeFileSync(join(f.worktree, "ticket.txt"), "new unreviewed work\n");
    assert.throws(() => executeDirectMerge(f.project, intent, "deliver"), /new changes.*preserved/);
    assert.equal(runGit(f.project, ["rev-parse", "main"]).stdout, intent.baseCommit);
    writeFileSync(join(f.worktree, "ticket.txt"), "reviewed implementation\n");
    executeDirectMerge(f.project, intent, "deliver");
    writeFileSync(join(f.worktree, "ticket.txt"), "edits made after the crash\n");
    assert.throws(() => verifyDirectMergeWorktree(f.project, intent), /new changes.*preserved/);
    assert.throws(() => removeDirectMergeWorktree(f.project, intent, f.worktree), /new changes.*preserved/);
    assert.equal(readFileSync(join(f.worktree, "ticket.txt"), "utf8"), "edits made after the crash\n");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("direct merge does not silently incorporate source or base commits made after its intent", () => {
  const f = fixture();
  try {
    const intent = prepareDirectMerge(f.project, "T1", "ticket/T1", "main", "squash");
    writeFileSync(join(f.worktree, "new.txt"), "not reviewed\n");
    runGit(f.worktree, ["add", "."]);
    runGit(f.worktree, ["commit", "-m", "unreviewed"]);
    assert.throws(() => executeDirectMerge(f.project, intent, "deliver"), /source branch changed/);
    writeFileSync(join(f.project, "later.txt"), "base moved\n");
    runGit(f.project, ["add", "."]);
    runGit(f.project, ["commit", "-m", "base moved again"]);
    assert.throws(() => reconcileDirectMerge(f.project, intent), /base changed without/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("rebase resumes after rebasing the checked-out ticket but before advancing the base", () => {
  const f = fixture();
  try {
    const intent = prepareDirectMerge(f.project, "T1", "ticket/T1", "main", "rebase");
    runGit(f.worktree, ["rebase", "main"]);
    assert.equal(reconcileDirectMerge(f.project, intent), undefined);
    const merged = executeDirectMerge(f.project, intent, "deliver");
    assert.equal(merged, runGit(f.project, ["rev-parse", "main"]).stdout);
    assert.equal(runGit(f.project, ["rev-parse", "main^{tree}"]).stdout, intent.expectedTree);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("squash resumes after staging the exact merge tree but before committing", () => {
  const f = fixture();
  try {
    const intent = prepareDirectMerge(f.project, "T1", "ticket/T1", "main", "squash");
    runGit(f.project, ["merge", "--squash", intent.branch]);
    const merged = executeDirectMerge(f.project, intent, "deliver");
    assert.equal(merged, runGit(f.project, ["rev-parse", "main"]).stdout);
    assert.equal(runGit(f.project, ["rev-parse", "main^{tree}"]).stdout, intent.expectedTree);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("squash preserves additional edits made after staging its merge tree", () => {
  const f = fixture();
  try {
    const intent = prepareDirectMerge(f.project, "T1", "ticket/T1", "main", "squash");
    runGit(f.project, ["merge", "--squash", intent.branch]);
    writeFileSync(join(f.project, "ticket.txt"), "new unreviewed edit\n");
    assert.throws(() => executeDirectMerge(f.project, intent, "deliver"), /unrecognized staged changes/);
    assert.equal(runGit(f.project, ["rev-parse", "main"]).stdout, intent.baseCommit);
    assert.equal(readFileSync(join(f.project, "ticket.txt"), "utf8"), "new unreviewed edit\n");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("merge commit resumes from its exact staged tree and source parent", () => {
  const f = fixture();
  try {
    const intent = prepareDirectMerge(f.project, "T1", "ticket/T1", "main", "merge");
    runGit(f.project, ["merge", "--no-ff", "--no-commit", intent.branch]);
    const merged = executeDirectMerge(f.project, intent, "deliver");
    assert.equal(merged, runGit(f.project, ["rev-parse", "main"]).stdout);
    assert.equal(runGit(f.project, ["show", "-s", "--format=%P", merged]).stdout, `${intent.baseCommit} ${intent.sourceCommit}`);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("finalization rejects source changes made while capturing its prospective Git tree", async () => {
  const f = fixture();
  const originalPath = process.env.PATH;
  try {
    const frozen = await captureFrozenQaSourceAsync(f.worktree);
    const protocol = new WorkflowDb(f.project);
    protocol.ensureRun("run");
    let head = protocol.qaTicketHead("run", "T1");
    head = protocol.transitionQa("run", "T1", head.revision, { type: "source-frozen", sourceStateDigest: frozen.digest });
    head = protocol.transitionQa("run", "T1", head.revision, { type: "review-ready", reviewBasisDigest: "basis", sessionGeneration: 0 });
    head = protocol.transitionQa("run", "T1", head.revision, { type: "turn-intended", slot: "initial" });
    const certificate = protocol.issueQaPassCertificate({ runId: "run", ticketId: "T1", qaRevision: head.revision + 1, sourceStateDigest: frozen.digest, reviewBasisDigest: "basis", turnReceiptDigest: "turn" });
    head = protocol.transitionQa("run", "T1", head.revision, { type: "review-passed", passCertificateId: certificate.certificateId });
    protocol.close();
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const bin = join(f.root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), `#!${process.execPath}\nconst {writeFileSync} = require('node:fs');\nconst {spawnSync} = require('node:child_process');\nif (process.argv[2] === 'write-tree') writeFileSync(${JSON.stringify(join(f.worktree, "ticket.txt"))}, 'changed during tree capture\\n');\nconst result = spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), {stdio: 'inherit'});\nprocess.exit(result.status ?? 1);\n`, { mode: 0o700 });
    process.env.PATH = `${bin}:${originalPath}`;
    await assert.rejects(beginQaFinalization(f.project, f.worktree, "run", "T1", certificate.certificateId, frozen.digest, "test"), /source changed while binding/);
    const invalidated = new WorkflowDb(f.project);
    try { assert.equal(invalidated.qaTicketHead("run", "T1").state, "operator-menu"); }
    finally { invalidated.close(); }
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    rmSync(f.root, { recursive: true, force: true });
  }
});

for (const crash of ["staged", "committed", "cleaned", "changed"] as const) {
  test(`branch runner reconciles ${crash} direct merge without dispatching Builder or QA`, async () => {
    const f = fixture();
    try {
      const ticket: TicketDef = { id: "T1", order: 1000, title: "Ticket", area: "Platform", priority: "P1", size: "S", risk: "Low", depends_on: [], summary: "Deliver", acceptance: ["Works"], required_tests: [], likely_files: ["ticket.txt"], rollback: null, notes: null };
      cmdInit(f.project, {});
      saveTickets(join(f.project, ".tickets", "tickets.yaml"), [ticket]);
      runGit(f.project, ["add", "."]);
      runGit(f.project, ["commit", "-m", "initialize tracker"]);
      const intent = prepareDirectMerge(f.project, "T1", "ticket/T1", "main", "squash");
      const db = new WorkflowDb(f.project);
      try {
        db.ensureRun("run");
        let head = db.qaTicketHead("run", "T1");
        head = db.transitionQa("run", "T1", head.revision, { type: "source-frozen", sourceStateDigest: "reviewed-source" });
        head = db.transitionQa("run", "T1", head.revision, { type: "review-ready", reviewBasisDigest: "basis", sessionGeneration: 0 });
        head = db.transitionQa("run", "T1", head.revision, { type: "turn-intended", slot: "initial" });
        const certificate = db.issueQaPassCertificate({ runId: "run", ticketId: "T1", qaRevision: head.revision + 1, sourceStateDigest: "reviewed-source", reviewBasisDigest: "basis", turnReceiptDigest: "receipt" });
        head = db.transitionQa("run", "T1", head.revision, { type: "review-passed", passCertificateId: certificate.certificateId });
        db.beginQaFinalization({ runId: "run", ticketId: "T1", certificateId: certificate.certificateId, consumer: "branch-finalization:T1", expectedSourceStateDigest: "reviewed-source", expectedGitTree: runGit(f.worktree, ["rev-parse", "HEAD^{tree}"]).stdout, allowedProjectionPaths: [], expectedRevision: head.revision, operationId: "finalize" });
        db.planOperation({ runId: "run", idempotencyKey: "run:direct-merge:T1", kind: "direct-merge", intent });
        db.updateOperation("run:direct-merge:T1", "in_progress");
        if (crash === "changed") writeFileSync(join(f.worktree, "ticket.txt"), "new unreviewed work\n");
        else if (crash === "staged") runGit(f.project, ["merge", "--squash", intent.branch]);
        else {
          const merged = executeDirectMerge(f.project, intent, "deliver");
          if (crash === "cleaned") {
            db.updateOperation("run:direct-merge:T1", "confirmed", { externalId: merged });
            removeDirectMergeWorktree(f.project, intent, f.worktree);
            runGit(f.project, ["branch", "-D", intent.branch]);
          }
        }
      } finally { db.close(); }
      const summaries = await runBranchPlan({ projectDir: f.project, runId: "run", plan: { baseRef: "main", nodes: [{ ticket, branch: intent.branch, baseRef: "main", baseBranch: "main", dependencies: [], depth: 1 }], issues: [] }, log: new Log(join(f.project, ".foreman", "test.jsonl")), notificationsEnabled: false, qaEnabled: true, createPr: false, prReady: false, keepWorktrees: false, completionMode: "direct-merge", createBuilder: async () => { throw new Error("Builder must not be created during finalization reconciliation"); } });
      assert.equal(summaries[0]?.buildStatus, crash === "changed" ? "blocked" : "done", summaries[0]?.detail);
      const verified = new WorkflowDb(f.project);
      try {
        assert.equal(verified.qaTicketHead("run", "T1").state, crash === "changed" ? "operator-menu" : "completed");
        assert.equal(verified.operation("run:direct-merge:T1")?.status, crash === "changed" ? "failed" : "confirmed");
        if (crash === "changed") {
          assert.match(summaries[0]?.detail ?? "", /--qa-revision \d+ --fresh-with-handoff/);
          assert.equal(readFileSync(join(f.worktree, "ticket.txt"), "utf8"), "new unreviewed work\n");
        }
      } finally { verified.close(); }
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}
