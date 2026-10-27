import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WorkflowDb } from "../src/workflowDb.js";
import { reusableCapabilityDecision } from "../src/humanDecision.js";
import { readBuildRuns } from "../src/buildRuns.js";

const exists = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const choices = [{ id: "allow-network", label: "Allow" }, { id: "stay-offline", label: "Offline" }];

test("a capability answer given with build:decide is reused once, never after it granted", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-capability-decision-"));
  try {
    const db = new WorkflowDb(dir);
    try {
      db.createRun({ runId: "run", kind: "build" });
      assert.equal(reusableCapabilityDecision(db, "run", "builder-network:"), undefined);
      const asked = db.ensureHumanDecision({ decisionKey: "k1", runId: "run", interruptionId: "builder-network:1:a", prompt: "Allow?", choices });
      assert.equal(reusableCapabilityDecision(db, "run", "builder-network:"), "builder-network:1:a", "a pending question is resumed");
      db.answerHumanDecision("run", asked.decisionId, "allow-network");
      assert.equal(reusableCapabilityDecision(db, "run", "builder-network:"), "builder-network:1:a", "an unused answer is reused");
      assert.equal(reusableCapabilityDecision(db, "run", "builder-network:", asked.decisionId), undefined, "the answer that granted is never reused");
      assert.equal(reusableCapabilityDecision(db, "run", "qa-network:"), undefined, "answers are scoped to one capability");
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/**
 * Regression: without a terminal the worker recorded the network question,
 * printed "Rafi is waiting for input", and then never exited, so its
 * supervisor stayed live and `rafi resume` refused the project.
 */
for (const detach of [false, true]) test(`non-interactive ${detach ? "detached " : ""}start exits after recording a capability question`, { timeout: 60000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "rafi-capability-exit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  const bin = join(root, "bin"); mkdirSync(bin);
  copyFileSync(fileURLToPath(new URL("fixtures/build-stall-codex.cjs", import.meta.url)), join(bin, "codex")); chmodSync(join(bin, "codex"), 0o755);
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/index.ts", import.meta.url)), "start", root, "--steps", "1", "--no-qa", "--agent", "codex", "--builder-network", ...(detach ? ["--detach"] : [])], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RAFI_BUILD_WORKER_RUN: "", RAFI_DETACHED_SUPERVISOR_RUN: "", PATH: `${bin}:${process.env.PATH}` },
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let output = ""; child.stdout.on("data", value => { output += value; }); child.stderr.on("data", value => { output += value; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  if (!detach) assert.equal(code, 2, output);
  const run = readBuildRuns(root)[0];
  assert.ok(run, output);
  // Every owner must be gone within a bounded time, leaving the question pending.
  const until = Date.now() + 30000;
  let owners: string[] = [];
  while (Date.now() < until) {
    const db = new WorkflowDb(root);
    try {
      const supervisor = db.supervisorState(run.runId);
      const admission = db.buildAdmission();
      owners = [supervisor?.pid, supervisor?.workerPid, admission?.pid]
        .filter((pid): pid is number => typeof pid === "number" && exists(pid)).map(String);
      if (!owners.length && db.pendingHumanDecisions(run.runId).some(decision => decision.interruptionId.startsWith("builder-network:"))) break;
    } finally { db.close(); }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.deepEqual(owners, [], `processes still alive after the question was recorded:\n${output}`);
  const db = new WorkflowDb(root);
  try { assert.equal(db.pendingHumanDecisions(run.runId).filter(decision => decision.interruptionId.startsWith("builder-network:")).length, 1, output); }
  finally { db.close(); }
  const supervisorLog = join(root, ".rafi", "logs", `supervisor-${run.runId}.log`);
  assert.match(detach && existsSync(supervisorLog) ? readFileSync(supervisorLog, "utf8") : output, /build:decide/);
});
