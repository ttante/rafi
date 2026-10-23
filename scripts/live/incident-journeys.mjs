/** Approved, opt-in public CLI journeys. Provider-free package tests remain separate. */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, openSync, closeSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { WorkflowReader } from "../../packages/ai-foreman/dist/workflowReader.js";
import { classifyProcess } from "../../packages/ai-foreman/dist/processIdentity.js";
import { createLiveWorkspace, liveProjectPath } from "./workspace.mjs";
import { freezeBuiltCli, verifyFrozenCli } from "./frozen-cli.mjs";
import { LIVE_INCIDENT_BRIEF } from "./incident-brief.mjs";
import { completedJourneyTickets } from "./journey-completion.mjs";
import { loadTicketsConfig, resolveTicketPaths } from "../../packages/ai-foreman/dist/tickets/config.js";
import { loadTickets } from "../../packages/ai-foreman/dist/tickets/ticketLoader.js";

if (process.env.RAFI_LIVE_INCIDENT !== "1") throw new Error("Explicit online authorization and RAFI_LIVE_INCIDENT=1 are required.");
const deadline = Date.parse(process.env.RAFI_LIVE_DEADLINE ?? "");
if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new Error("A valid authorized absolute deadline is required.");
const providers = (process.env.RAFI_LIVE_PROVIDERS ?? "claude,codex").split(",");
assert.ok(providers.every(provider => ["claude", "codex"].includes(provider)));
const repetitions = Number(process.env.RAFI_LIVE_REPETITIONS ?? 3);
const interruptRestart = process.env.RAFI_LIVE_INTERRUPT_RESTART === "1";
assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 3);
const buildTimeoutMs = provider => Number(process.env.RAFI_LIVE_BUILD_TIMEOUT_MS ?? (provider === "claude" ? 1_800_000 : 900_000));

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files.sort();
}
function verifyBuildFreshness() {
  const packages = ["spec", "ai-foreman", "rafi"];
  const sources = packages.flatMap(name => sourceFiles(resolve(fileURLToPath(new URL("../../packages/" + name + "/src", import.meta.url)))));
  const newestSource = Math.max(...sources.map(path => statSync(path).mtimeMs));
  const entrypoints = packages.map(name => resolve(fileURLToPath(new URL("../../packages/" + name + "/dist/index.js", import.meta.url))));
  const oldestEntrypoint = Math.min(...entrypoints.map(path => statSync(path).mtimeMs));
  if (oldestEntrypoint < newestSource) throw new Error("Generated dist is older than TypeScript source; run npm run build before the live canary");
  const sourceDigest = createHash("sha256").update(sources.map(path => path + "\0" + readFileSync(path)).join("\0")).digest("hex");
  return { sourceDigest, newestSource: new Date(newestSource).toISOString(), oldestEntrypoint: new Date(oldestEntrypoint).toISOString(), verifiedAt: new Date().toISOString() };
}
const continuedCandidate = process.env.RAFI_LIVE_CONTINUE_COMPLETED === "1"
  ? JSON.parse(readFileSync(join(process.env.RAFI_LIVE_PREDECESSOR_EVIDENCE, "ledger.json"), "utf8")) : undefined;
const build = continuedCandidate ? { ...continuedCandidate.build } : verifyBuildFreshness();
const liveWorkspace = createLiveWorkspace("rafi-live-incident-journeys-");
const root = liveWorkspace.evidenceRoot;
const workspaceRoot = liveWorkspace.workspaceRoot;
const frozen = continuedCandidate
  ? verifyFrozenCli(join(process.env.RAFI_LIVE_PREDECESSOR_EVIDENCE, "runtime"))
  : freezeBuiltCli(resolve(fileURLToPath(new URL("../..", import.meta.url))), join(root, "runtime"));
const cli = frozen.cli;
build.frozen = frozen;
const ledger = [];
const save = () => writeFileSync(join(root, "ledger.json"), JSON.stringify({ profile: "online-only CLI journeys", providers, repetitions, deadline: new Date(deadline).toISOString(), evidenceRoot: root, providerWorkspaceRoot: workspaceRoot, build, ledger }, null, 2));
console.log(`Public CLI journey evidence: ${root}`); save();
async function phase(project, provider, seed, name, args, limitMs, expectedCodes = [0]) {
  const remaining = deadline - Date.now(); if (remaining <= 0) throw new Error("Authorized online deadline reached");
  const log = join(root, `${provider}-${seed}-${name}.log`); const fd = openSync(log, "w", 0o600);
  const row = { provider, seed, phase: name, args, log, startedAt: new Date().toISOString(), status: "running" }; ledger.push(row); save();
  console.log(`${provider} seed ${seed}: ${name}`);
  const child = spawn(process.execPath, [cli, ...args], { cwd: project, env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", fd, fd] });
  let timedOut = false, force, interrupted = false, watchError;
  const baselineSource = name === "build-interrupt" ? readFileSync(join(project, "index.mjs"), "utf8") : undefined;
  const watch = name === "build-interrupt" ? setInterval(() => {
    try {
      if (interrupted || readFileSync(join(project, "index.mjs"), "utf8") === baselineSource) return;
      const reader = new WorkflowReader(project);
      try {
        const run = reader.buildRuns()[0];
        if (run && reader.operations(run.runId).some(op => op.kind === "provider-dispatch" && op.status === "in_progress" && op.intent.role === "builder")) {
          if (process.env.RAFI_LIVE_INTERRUPT_WORKER_KILL === "1") {
            const owner = reader.currentLease();
            assert.equal(owner?.runId, run.runId);
            assert.equal(classifyProcess(owner.pid, owner.processStart, owner.host).state, "live", "Worker ownership must be verified before fault injection");
            assert.notEqual(owner.pid, process.pid);
            row.interruptedWorkerPid = owner.pid; row.interruptionSignal = "SIGKILL";
            process.kill(owner.pid, "SIGKILL");
          } else { row.interruptionSignal = "SIGTERM"; child.kill("SIGTERM"); }
          interrupted = true; row.interruptedRunId = run.runId; row.interruptedAt = new Date().toISOString(); save();
        }
      } finally { reader.close(); }
    } catch (error) { watchError = error; child.kill("SIGTERM"); clearInterval(watch); }
  }, 100) : undefined;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); force = setTimeout(() => child.kill("SIGKILL"), 45_000); }, Math.min(remaining, limitMs));
  try {
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    Object.assign(row, { status: expectedCodes.includes(code) && !timedOut && !watchError ? interrupted ? "expected-interruption" : code === 0 ? "pass" : "expected-approval-pause" : "fail", code, timedOut, finishedAt: new Date().toISOString() }); save();
    assert.equal(timedOut, false, `${provider} ${name} deadline exceeded; evidence preserved in ${log}`);
    assert.ifError(watchError);
    assert.ok(expectedCodes.includes(code), `${provider} ${name} failed (${code}); evidence preserved in ${log}`);
    if (name === "build-interrupt") assert.equal(interrupted, true, "Build completed before a real active-turn interruption; scenario not validated");
    return code;
  } finally { clearTimeout(timer); clearTimeout(force); clearInterval(watch); closeSync(fd); }
}
async function restartInterrupted(project, provider, seed, runId) {
  const git = args => execFileSync("git", args, { cwd: project, stdio: "pipe" });
  const before = new WorkflowReader(project);
  let unresolved;
  try {
    assert.ok(["recoverable", "paused", "failed"].includes(before.getRun(runId).status), "Interrupted workflow must not remain running");
    unresolved = before.operations(runId).filter(op => op.kind === "provider-dispatch" && ["in_progress", "uncertain"].includes(op.status));
    assert.ok(unresolved.length, "Interrupted dispatch evidence must remain");
  } finally { before.close(); }
  const preservedSource = readFileSync(join(project, "index.mjs"), "utf8");
  const branch = git(["branch", "--show-current"]).toString().trim();
  await phase(project, provider, seed, "ticket-reset", ["tickets", "reset", "--project", project, "--scope", "all", "--yes"], 60_000);
  const afterReset = new WorkflowReader(project);
  try { assert.ok(unresolved.every(op => ["in_progress", "uncertain"].includes(afterReset.operations(runId).find(current => current.idempotencyKey === op.idempotencyKey).status)), "Tracker reset must not retire provider uncertainty"); }
  finally { afterReset.close(); }
  await phase(project, provider, seed, "keep-files-start-over", ["build:start-over", ".", "--run", runId, "--action", "restart-current", "--yes"], 60_000);
  assert.equal(readFileSync(join(project, "index.mjs"), "utf8"), preservedSource);
  assert.equal(git(["branch", "--show-current"]).toString().trim(), branch);
  const retired = new WorkflowReader(project);
  try { assert.equal(retired.getRun(runId).status, "superseded"); assert.equal(retired.operations(runId).filter(op => op.kind === "provider-dispatch" && ["in_progress", "uncertain"].includes(op.status)).length, 0); }
  finally { retired.close(); }
  const restartCode = await phase(project, provider, seed, "fresh-build-after-start-over", ["start", ".", "--agent", provider, "--steps", "2", "--yes"], buildTimeoutMs(provider), [0, 2]);
  if (restartCode === 2) {
    const pending = new WorkflowReader(project); let fresh, approval;
    try { fresh = pending.buildRuns()[0]; const choices = pending.pendingHumanDecisions(fresh.runId); assert.equal(choices.length, 1); approval = choices[0]; assert.equal(approval.prompt, "How does this plan look?"); }
    finally { pending.close(); }
    await phase(project, provider, seed, "fresh-build-approve", ["build:decide", ".", "--run", fresh.runId, "--decision", approval.decisionId, "--choice", "proceed"], 30_000);
    await phase(project, provider, seed, "fresh-build-resume", ["resume", ".", "--run", fresh.runId, "--yes"], buildTimeoutMs(provider));
  }
}
async function driveRemainingTickets(project, provider, seed) {
    const expectedTickets = loadTickets(resolveTicketPaths(loadTicketsConfig(project), project).tickets).map(ticket => ticket.id).sort();
    assert.equal(expectedTickets.length, 2, "The approved journey must contain exactly two tickets");
    for (let unit = 1; unit <= expectedTickets.length; unit++) {
      const completedBefore = completedJourneyTickets(project);
      if (expectedTickets.every(id => completedBefore.some(row => row.ticketId === id))) break;
      const phaseName = name => unit === 1 ? name : `${name}-unit-${unit}`;
    const buildCode = await phase(project, provider, seed, phaseName("build"), ["start", ".", "--agent", provider, "--steps", "2", "--yes"], buildTimeoutMs(provider), [0, 2]);
    if (buildCode === 2) {
      const state = new WorkflowReader(project);
      let run, decision;
      try {
        run = state.buildRuns()[0];
        const decisions = state.pendingHumanDecisions(run.runId);
        assert.equal(decisions.length, 1, "Unexpected pause; stop and diagnose");
        decision = decisions[0]; assert.equal(decision.prompt, "How does this plan look?");
        assert.ok(decision.choices.some(choice => choice.id === "proceed"));
      } finally { state.close(); }
      await phase(project, provider, seed, phaseName("build-approve"), ["build:decide", ".", "--run", run.runId, "--decision", decision.decisionId, "--choice", "proceed"], 30_000);
      await phase(project, provider, seed, interruptRestart && unit === 1 ? "build-interrupt" : phaseName("build-resume"), ["resume", ".", "--run", run.runId, "--yes"], buildTimeoutMs(provider), interruptRestart && unit === 1 ? [2] : [0]);
      if (interruptRestart && unit === 1) {
        await restartInterrupted(project, provider, seed, run.runId);
      }
    }
      const completedAfter = completedJourneyTickets(project);
      assert.ok(completedAfter.length > completedBefore.length, "Delivery unit produced no newly finalized QA-certified ticket; do not blindly retry");
    }
}
const brief = LIVE_INCIDENT_BRIEF;
try {
  for (const provider of providers) for (let seed = 1; seed <= repetitions; seed++) {
    const existing = process.env.RAFI_LIVE_CONTINUE_INTERRUPTED_PROJECT;
    const project = existing ? resolve(existing) : liveProjectPath(workspaceRoot, `${provider}-${seed}`);
    if (existing) {
      assert.equal(repetitions, 1); assert.equal(providers.length, 1);
      assert.ok(project.startsWith(workspaceRoot + "/") || /\/(?:rafi-live-incident-journeys-|rf-w-)[^/]+\/(?:claude|codex)-\d+$/.test(project), "Continuation must use a disposable live provider workspace");
      assert.equal(JSON.parse(readFileSync(join(project, "package.json"), "utf8")).name, "rafi-live-arithmetic-fixture");
      const reader = new WorkflowReader(project); let interrupted;
      try { interrupted = reader.buildRuns()[0]; assert.ok(interrupted); } finally { reader.close(); }
      if (process.env.RAFI_LIVE_CONTINUE_COMPLETED === "1") {
        assert.equal(interrupted.status, "completed", "Continuation only follows a completed delivery unit");
        assert.ok(completedJourneyTickets(project).length > 0, "No certified completed unit to continue");
        const predecessor = JSON.parse(readFileSync(join(process.env.RAFI_LIVE_PREDECESSOR_EVIDENCE, "ledger.json"), "utf8"));
        assert.equal(predecessor.build.frozen.digest, build.frozen.digest, "A delivery-unit continuation must use the exact same compiled candidate");
        assert.equal(resolve(predecessor.providerWorkspaceRoot, `${provider}-${seed}`), project);
        ledger.push({ provider, seed, phase: "continue-completed-unit", predecessorEvidence: process.env.RAFI_LIVE_PREDECESSOR_EVIDENCE, status: "pass" }); save();
        await driveRemainingTickets(project, provider, seed);
      } else if (process.env.RAFI_LIVE_CONTINUE_APPROVAL === "1") {
        const state = new WorkflowReader(project); let decision;
        try { const pending = state.pendingHumanDecisions(interrupted.runId); assert.equal(pending.length, 1); decision = pending[0]; assert.equal(decision.prompt, "How does this plan look?"); assert.ok(decision.choices.some(choice => choice.id === "proceed")); }
        finally { state.close(); }
        await phase(project, provider, seed, "continued-build-approve", ["build:decide", ".", "--run", interrupted.runId, "--decision", decision.decisionId, "--choice", "proceed"], 30_000);
        await phase(project, provider, seed, "continued-build-resume", ["resume", ".", "--run", interrupted.runId, "--yes"], buildTimeoutMs(provider));
      } else if (process.env.RAFI_LIVE_CONTINUE_FAILED === "1") {
        assert.ok(["failed", "paused"].includes(interrupted.status));
        await phase(project, provider, seed, "continued-failed-build-resume", ["resume", ".", "--run", interrupted.runId, "--yes"], buildTimeoutMs(provider));
      } else await restartInterrupted(project, provider, seed, interrupted.runId);
    } else {
    mkdirSync(join(project, "test"), { recursive: true });
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "rafi-live-arithmetic-fixture", private: true, type: "module", scripts: { test: "node --test test/*.test.mjs" } }, null, 2));
    writeFileSync(join(project, "index.mjs"), "export const add = (a, b) => a + b;\n");
    writeFileSync(join(project, "test", "add.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; import {add} from '../index.mjs'; test('add is preserved', () => assert.equal(add(2,3),5));\n");
    writeFileSync(join(project, "README.md"), "Disposable arithmetic library. Validate with npm test. No dependencies or external operations.\n");
    const git = args => execFileSync("git", args, { cwd: project, stdio: "pipe" });
    git(["init", "-q", "-b", "main"]); git(["config", "user.email", "rafi-live@example.test"]); git(["config", "user.name", "Rafi disposable live fixture"]); git(["add", "."]); git(["commit", "-qm", "Disposable fixture baseline"]);
    await phase(project, provider, seed, "create", ["create", ".", "--defaults", "--no-graph", "--runtime", provider, "--docs-root", "docs-rafi"], 180_000);
    await phase(project, provider, seed, "plan", ["plan", ".", "--agent", provider, "--brief", brief, "--no-grill-me", "--yes"], 300_000);
    await phase(project, provider, seed, "ticket-setup", ["tickets", "setup:init", "--project", project, "--defaults", "--branch-strategy", "current", "--completion", "none", "--population-mode", "approved_plan"], 60_000);
    await phase(project, provider, seed, "populate", ["tickets", "populate", "--project", project, "--agent", provider, "--yes"], 300_000);
    await phase(project, provider, seed, "validate", ["tickets", "validate", "--project", project], 60_000);
    await phase(project, provider, seed, "queue", ["tickets", "queue", "--project", project], 60_000);
    await driveRemainingTickets(project, provider, seed);
    }
    const expectedTicketsFinal = loadTickets(resolveTicketPaths(loadTicketsConfig(project), project).tickets).map(ticket => ticket.id).sort();
    const completionEvidence = completedJourneyTickets(project);
    assert.equal(expectedTicketsFinal.length, 2);
    assert.deepEqual([...new Set(completionEvidence.map(row => row.ticketId))].sort(), expectedTicketsFinal, "Every approved ticket needs its own consumed QA certificate and completed finalization");
    ledger.push({ provider, seed, phase: "all-ticket-certificates", status: "pass", completionEvidence }); save();
    execFileSync("npm", ["test"], { cwd: project, env: process.env, stdio: "pipe", timeout: 30_000 });
    const source = readFileSync(join(project, "index.mjs"), "utf8"); assert.match(source, /subtract/); assert.match(source, /multiply/); assert.match(source, /add/);
    const reader = new WorkflowReader(project);
    try { const builds = reader.buildRuns(); assert.ok(builds.some(run => run.status === "completed"), "No durable completed build"); assert.equal(builds.flatMap(run => reader.operations(run.runId)).filter(op => op.kind === "provider-dispatch" && ["in_progress", "uncertain"].includes(op.status)).length, 0); }
    finally { reader.close(); }
    ledger.push({ provider, seed, phase: "durable-completion-and-independent-app-test", status: "pass" }); save();
  }
} catch (error) { ledger.push({ status: "fail", error: String(error) }); save(); throw error; }
console.log(JSON.stringify({ journeysPassed: providers.length * repetitions, evidence: root }));
