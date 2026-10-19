import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify } from "yaml";
import { readBuildRuns } from "ai-foreman/build-runs.js";
import { WorkflowDb } from "ai-foreman/workflow-db.js";

const cli = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const fixture = fileURLToPath(new URL("fixtures/e2e-codex.cjs", import.meta.url));
const qaFixture = fileURLToPath(new URL("fixtures/e2e-codex-qa.cjs", import.meta.url));

function run(root: string, args: string[], accepted = [0], extraEnv: Record<string, string> = {}): string {
  const result = spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
    // The fixture is the Rafi target, not the package that owns the TSX loader.
    // Keep Node's module resolution rooted in this source checkout while every
    // Rafi command receives the disposable project explicitly.
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, ...extraEnv, PATH: `${join(root, "bin")}${delimiter}${process.env.PATH ?? ""}` },
    encoding: "utf8",
    timeout: 120_000,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.equal(result.error, undefined, output);
  assert.ok(result.status !== null && accepted.includes(result.status), output);
  return output;
}

test("clean-room onboarding admits a Builder after create, plan, populate, queue, and start", { timeout: 180_000 }, t => {
  const root = mkdtempSync(join(tmpdir(), "rafi-e2e-workflow-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "Rafi E2E"]);
  execFileSync("git", ["-C", root, "config", "user.email", "e2e@example.test"]);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "rafi-e2e-fixture", private: true }, null, 2));
  writeFileSync(join(root, "README.md"), "# Rafi E2E fixture\n");
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-qm", "fixture baseline"]);
  mkdirSync(join(root, "bin"));
  copyFileSync(fixture, join(root, "bin", "codex"));
  chmodSync(join(root, "bin", "codex"), 0o755);
  execFileSync("git", ["-C", root, "add", "bin/codex"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "scripted provider fixture"]);

  run(root, ["create", root, "--defaults", "--no-graph", "--runtime", "codex"]);
  const configPath = join(root, "rafi-config.yaml");
  const config = parseYaml(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  config.qa_preparation = false;
  writeFileSync(configPath, stringify(config), "utf8");
  run(root, ["plan", root, "--brief", "Add a small safe feature", "--agent", "codex", "--yes", "--no-grill-me"]);
  run(root, ["tickets", "setup:init", "--project", root, "--defaults", "--population-mode", "approved_plan"]);
  const population = run(root, ["tickets", "populate", "--project", root, "--agent", "codex", "--yes"]);
  assert.match(population, /asking Ticket Maker for a targeted correction \(1\/2\)/);
  assert.match(population, /populated atomically/);
  const validation = run(root, ["tickets", "validate", "--project", root]);
  assert.match(validation, /all 4 passes clean/i);
  const queue = run(root, ["tickets", "queue", "--project", root]);
  assert.match(queue, /T001/);
  run(root, ["start", root, "--steps", "1", "--no-qa", "--yes", "--agent", "codex", "--dirty-work", "include"]);

  const tickets = parseYaml(readFileSync(join(root, ".tickets", "tickets.yaml"), "utf8")) as { tickets: Array<{ risk: string; rollback: string | null }> };
  assert.equal(tickets.tickets.length, 1);
  assert.equal(tickets.tickets[0]?.risk, "Medium");
  assert.match(tickets.tickets[0]?.rollback ?? "", /Disable the feature path/);
  const runRecord = readBuildRuns(root)[0];
  assert.ok(runRecord, "start must create a durable build run");
  const db = new WorkflowDb(root);
  try {
    assert.equal(db.getRun(runRecord.runId)?.status, "completed");
    assert.equal(db.assertAdmittedWork(runRecord.runId, "T001").workId, "T001");
  } finally {
    db.close();
  }
});

test("QA preparation failure does not admit the Builder", { timeout: 180_000 }, t => {
  const root = mkdtempSync(join(tmpdir(), "rafi-e2e-invalid-qa-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "Rafi E2E"]); execFileSync("git", ["-C", root, "config", "user.email", "e2e@example.test"]);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "rafi-e2e-invalid-qa", private: true })); writeFileSync(join(root, "README.md"), "# QA fixture\n");
  mkdirSync(join(root, "bin")); copyFileSync(qaFixture, join(root, "bin", "codex")); chmodSync(join(root, "bin", "codex"), 0o755);
  execFileSync("git", ["-C", root, "add", "."]); execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
  run(root, ["create", root, "--defaults", "--no-graph", "--runtime", "codex"]);
  run(root, ["plan", root, "--brief", "Add a small safe feature", "--agent", "codex", "--yes", "--no-grill-me"]);
  run(root, ["tickets", "setup:init", "--project", root, "--defaults", "--population-mode", "approved_plan", "--branch-strategy", "current", "--completion", "none"]);
  run(root, ["tickets", "populate", "--project", root, "--agent", "codex", "--yes"]);
  run(root, ["start", root, "--steps", "1", "--no-qa", "--yes", "--agent", "codex", "--dirty-work", "include"], [0, 2]);
  const record = readBuildRuns(root)[0]; assert.ok(record);
  const pendingDb = new WorkflowDb(root); let decisionId: string;
  try { const decisions = pendingDb.pendingHumanDecisions(record.runId); assert.equal(decisions.length, 1); decisionId = decisions[0]!.decisionId; } finally { pendingDb.close(); }
  run(root, ["build:decide", root, "--run", record.runId, "--decision", decisionId, "--choice", "proceed"]);
  const output = run(root, ["resume", root, "--run", record.runId, "--yes"], [1, 2], { RAFI_E2E_BAD_QA: "1" });
  assert.match(output, /not-an-existing-file/);
  const db = new WorkflowDb(root);
  try { const admission = db.assertAdmittedWork(record.runId, "T001"); assert.notEqual(db.qaPreparationStore().head(record.runId, "T001", admission.requirementsDigest).state, "ready"); } finally { db.close(); }
  assert.throws(() => readFileSync(join(root, "implemented.txt"), "utf8"), /ENOENT/);
});

test("onboarding admits Builder only after QA-enabled preparation and independent assessment", { timeout: 180_000 }, t => {
  const root = mkdtempSync(join(tmpdir(), "rafi-e2e-qa-workflow-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "Rafi E2E"]);
  execFileSync("git", ["-C", root, "config", "user.email", "e2e@example.test"]);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "rafi-e2e-qa-fixture", private: true }));
  writeFileSync(join(root, "README.md"), "# QA-enabled Rafi E2E fixture\n");
  mkdirSync(join(root, "bin")); copyFileSync(qaFixture, join(root, "bin", "codex")); chmodSync(join(root, "bin", "codex"), 0o755);
  execFileSync("git", ["-C", root, "add", "."]); execFileSync("git", ["-C", root, "commit", "-qm", "fixture baseline"]);
  run(root, ["create", root, "--defaults", "--no-graph", "--runtime", "codex"]);
  const config = parseYaml(readFileSync(join(root, "rafi-config.yaml"), "utf8")) as Record<string, unknown>;
  assert.equal(config.qa_preparation, true);
  run(root, ["plan", root, "--brief", "Add a small safe feature", "--agent", "codex", "--yes", "--no-grill-me"]);
  run(root, ["tickets", "setup:init", "--project", root, "--defaults", "--population-mode", "approved_plan", "--branch-strategy", "current", "--completion", "none"]);
  run(root, ["tickets", "populate", "--project", root, "--agent", "codex", "--yes"]);
  assert.match(run(root, ["tickets", "validate", "--project", root]), /all 4 passes clean/i);
  assert.match(run(root, ["tickets", "queue", "--project", root]), /T001/);
  // Final QA is disabled in this admission-focused test; preparation remains enforced.
  const started = run(root, ["start", root, "--steps", "1", "--no-qa", "--yes", "--agent", "codex", "--dirty-work", "include"], [0, 2]);
  const record = readBuildRuns(root)[0]; assert.ok(record);
  if (started.includes("How does this plan look?")) {
    const pendingDb = new WorkflowDb(root);
    let decisionId: string;
    try { const decisions = pendingDb.pendingHumanDecisions(record.runId); assert.equal(decisions.length, 1); decisionId = decisions[0]!.decisionId; } finally { pendingDb.close(); }
    run(root, ["build:decide", root, "--run", record.runId, "--decision", decisionId, "--choice", "proceed"]);
    run(root, ["resume", root, "--run", record.runId, "--yes"]);
  }
  const db = new WorkflowDb(root);
  try {
    const admission = db.assertAdmittedWork(record.runId, "T001"), store = db.qaPreparationStore();
    const head = store.head(record.runId, "T001", admission.requirementsDigest);
    assert.equal(head.state, "ready"); assert.ok(head.digest);
    assert.ok(store.contract(head.digest).semanticAssessmentDigest);
    assert.ok(store.budget(record.runId, "T001", admission.requirementsDigest)?.reservations.some(item => item.kind === "assessment" && item.resultDigest));
    assert.match(readFileSync(join(root, "implemented.txt"), "utf8"), /scripted implementation/);
  } finally { db.close(); }
});
