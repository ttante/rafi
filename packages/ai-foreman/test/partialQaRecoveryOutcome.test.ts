import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { WorkflowDb } from "../src/workflowDb.js";
import { processStartIdentity } from "../src/processIdentity.js";

async function drainingGroupFixture() {
  const directory = mkdtempSync(join(tmpdir(), "rafi-qa-settlement-group-")), marker = join(directory, "release");
  const drainScript = 'const fs=require("node:fs"); const poll=setInterval(()=>{if(fs.existsSync(process.argv[1])){clearInterval(poll);process.exit(0)}},20); setTimeout(()=>process.exit(0),10000);';
  const script = `const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e",${JSON.stringify(drainScript)},process.argv[1]],{stdio:"ignore"}); child.unref(); process.stdout.write(String(process.pid));`;
  const child = spawn(process.execPath, ["-e", script, marker], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout!.on("data", data => { output += String(data); });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, 0);
  const pid = Number(output); assert.ok(Number.isSafeInteger(pid) && pid > 0);
  return { pid, release: () => writeFileSync(marker, "released\n"), close: () => {
    try { process.kill(-pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    finally { rmSync(directory, { recursive: true, force: true }); }
  } };
}

function proof() {
  const deadPid = Number(execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }));
  const run = { status: "paused", checkpoint: "qa-recovery-complete", state: { status: "recoverable", progress: { completedTickets: ["T004"] } } };
  const launch = { runId: "run", role: "coordinator", state: "claimed", createdAt: "2026-10-15T00:00:00Z", claimant: { pid: deadPid, processStart: "dead-fixture", host: hostname() } };
  const supervisor = { status: "waiting_for_human", pid: deadPid, processStart: "dead-fixture", workerGeneration: 3, workerPid: undefined as number | undefined };
  const start = { type: "worker_started", at: "2026-10-15T00:00:01Z", payload: { workerPid: deadPid, processStart: "dead-fixture", host: hostname(), generation: 3 } };
  const exit = { type: "worker_exit", at: "2026-10-15T00:00:02Z", payload: { code: 0, signal: null as string | null, stopRequested: false, generation: 3 } };
  const state = { qa: "completed", decisions: [] as object[], readiness: [] as object[], dispatches: [] as object[] };
  // A deterministic read facade exercises the production admission predicate;
  // native worker death/group visibility remains real and is never mocked.
  const reader = { getRun: () => run, buildLaunch: () => launch, supervisorState: () => supervisor,
    qaTicketHead: () => ({ state: state.qa }), pendingHumanDecisions: () => state.decisions,
    readinessProcesses: () => state.readiness, unresolvedRoleDispatches: () => state.dispatches, events: () => [start, exit] };
  return { run, launch, supervisor, start, exit, state, reader,
    accepted: () => WorkflowDb.prototype.successfulPartialQaRecovery.call(reader as unknown as WorkflowDb, "run", "T004", "current-launch") };
}

test("partial QA recovery requires supported native owned-group proof after a clean accepted boundary", () => {
  // The POSIX inventory is deliberately unsupported on Windows. Process
  // death alone must not authorize automatic continuation there.
  assert.equal(proof().accepted(), process.platform !== "win32");
});

test("partial QA settlement wait preserves clean exact proof and rejects unsafe boundaries immediately", async () => {
  const f = proof();
  const accepted = await WorkflowDb.prototype.waitForSuccessfulPartialQaRecovery.call(f.reader as unknown as WorkflowDb, "run", "T004", "current-launch");
  assert.equal(accepted, process.platform !== "win32");
  for (const invalidate of [() => { f.state.dispatches.push({}); }, () => { f.exit.payload.code = 1; }, () => { f.exit.payload.generation++; }]) {
    invalidate();
    const started = Date.now();
    assert.equal(await WorkflowDb.prototype.waitForSuccessfulPartialQaRecovery.call(f.reader as unknown as WorkflowDb, "run", "T004", "current-launch"), false);
    assert.ok(Date.now() - started < 1000, "unsafe business proofs must not wait for process settlement");
  }
});

test("partial QA waits for an owned clean-exit descendant to drain without killing it", { skip: process.platform === "win32" }, async () => {
  const group = await drainingGroupFixture(), pid = group.pid, f = proof();
  Object.assign(f.start.payload, { workerPid: pid });
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    assert.equal(f.accepted(), false, "active owned group must block immediate continuation");
    const started = Date.now();
    releaseTimer = setTimeout(group.release, 300);
    assert.equal(await WorkflowDb.prototype.waitForSuccessfulPartialQaRecovery.call(f.reader as unknown as WorkflowDb, "run", "T004", "current-launch"), true);
    assert.ok(Date.now() - started >= 100, "settlement must await descendant exit");
  } finally {
    clearTimeout(releaseTimer);
    group.close();
  }
});

test("partial QA settlement cannot borrow a changed coherent worker generation", { skip: process.platform === "win32" }, async () => {
  const group = await drainingGroupFixture(), pid = group.pid, f = proof();
  Object.assign(f.start.payload, { workerPid: pid });
  const mutation = setTimeout(() => { f.supervisor.workerGeneration++; f.start.payload.generation++; f.exit.payload.generation++; }, 100);
  try {
    assert.equal(await WorkflowDb.prototype.waitForSuccessfulPartialQaRecovery.call(f.reader as unknown as WorkflowDb, "run", "T004", "current-launch"), false);
  } finally {
    clearTimeout(mutation);
    group.close();
  }
});
for (const condition of ["worker-crash", "worker-signal", "operator-stop", "foreign-generation", "old-exit", "old-start", "foreign-launch", "active-supervisor", "active-worker", "missing-worker-proof", "uncompleted-qa", "cleanup-pending", "decision-pending", "dispatch-unknown", "wrong-checkpoint"] as const) {
  test(`successful partial QA recovery rejects ${condition}`, () => {
    const f = proof();
    if (condition === "worker-crash") f.exit.payload.code = 1;
    if (condition === "worker-signal") f.exit.payload.signal = "SIGKILL";
    if (condition === "operator-stop") f.exit.payload.stopRequested = true;
    if (condition === "foreign-generation") f.exit.payload.generation++;
    if (condition === "old-exit") f.exit.at = "2026-10-14T23:59:00Z";
    if (condition === "old-start") f.start.at = "2026-10-14T23:59:00Z";
    if (condition === "foreign-launch") f.launch.claimant.processStart = "foreign-supervisor";
    if (condition === "active-supervisor") Object.assign(f.launch.claimant, { pid: process.pid, processStart: processStartIdentity() });
    if (condition === "active-worker") Object.assign(f.start.payload, { workerPid: process.pid, processStart: processStartIdentity() });
    if (condition === "missing-worker-proof") f.start.payload.host = "unverified-host";
    if (condition === "uncompleted-qa") f.state.qa = "turn-uncertain";
    if (condition === "cleanup-pending") f.state.readiness.push({ state: "unverified" });
    if (condition === "decision-pending") f.state.decisions.push({ status: "pending" });
    if (condition === "dispatch-unknown") f.state.dispatches.push({ status: "uncertain" });
    if (condition === "wrong-checkpoint") f.run.checkpoint = "worker-reconciliation-required";
    assert.equal(f.accepted(), false);
  });
}
