/**
 * Opt-in native acceptance for branch-per-ticket recovery scope.
 *
 * It interrupts the first ticket while QA is active, resumes that exact run,
 * verifies that the untouched second ticket remains recoverable, then performs
 * the public follow-up resume and verifies whole-run completion. Every fixture
 * is disposable and no remote Git action is requested.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLiveWorkspace, liveProjectPath } from "./workspace.mjs";
import { stringify } from "yaml";
import Database from "better-sqlite3";
import { cmdUpdate } from "../../packages/ai-foreman/src/tickets/commands.js";
import { readBuildRuns } from "../../packages/ai-foreman/src/buildRuns.js";
import { WorkflowReader } from "../../packages/ai-foreman/src/workflowReader.js";

import { runSupervisedStructuredLive, trackStructuredLiveChild } from "./structured-live-supervisor.mjs";

await runSupervisedStructuredLive("branch-scope-recovery", async (supervisor) => {
if (process.env.RAFI_LIVE_BRANCH_SCOPE !== "1") throw new Error("Set RAFI_LIVE_BRANCH_SCOPE=1 only with explicit provider authorization");
const deadline = Date.parse(process.env.RAFI_LIVE_DEADLINE ?? "");
assert.ok(Number.isFinite(deadline) && deadline > Date.now(), "Set a future RAFI_LIVE_DEADLINE absolute timestamp");
const providers = (process.env.RAFI_LIVE_PROVIDERS ?? "claude,codex").split(",") as Array<"claude" | "codex">;
assert.ok(providers.length > 0 && providers.every(provider => provider === "claude" || provider === "codex"));
assert.equal(new Set(providers).size, providers.length, "providers must not repeat");

const workspace = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const cli = join(workspace, "packages/rafi/dist/index.js");
const liveWorkspace = createLiveWorkspace("rafi-live-branch-scope-");
const root = liveWorkspace.evidenceRoot;
const workspaceRoot = liveWorkspace.workspaceRoot;
const ledger: Array<Record<string, unknown>> = [];
const save = () => writeFileSync(join(root, "ledger.json"), JSON.stringify({ root, deadline: new Date(deadline).toISOString(), providers, ledger }, null, 2));
save();
console.log(`Branch scope evidence: ${root}`);

const ticket = (id: string, order: number, name: string, expression: string) => ({
  id, order, title: `Implement ${name}`, area: "core", priority: "P1", size: "S", risk: "Low",
  summary: `Implement and export ${name}(value) in api.mjs. ${name}(value) returns ${expression}. Do not add dependencies or use the network.`,
  acceptance: [`${name}(3) has the specified result`, "npm test passes"], required_tests: ["npm test"], likely_files: ["api.mjs", `test/${name}.test.mjs`], depends_on: [],
});

function state(project: string) {
  const reader = new WorkflowReader(project);
  const run = readBuildRuns(project)[0];
  try {
    const details = run && existsSync(reader.path) ? (() => {
      const db = new Database(reader.path, { readonly: true, fileMustExist: true });
      try {
        return {
          qa: db.prepare("SELECT ticket_id AS ticketId,state FROM qa_ticket_heads WHERE run_id=? ORDER BY ticket_id").all(run.runId) as Array<{ ticketId: string; state: string }>,
          qaSessions: Number((db.prepare("SELECT COUNT(*) AS count FROM provider_sessions WHERE run_id=? AND role='qa'").get(run.runId) as { count: number }).count),
        };
      }
      finally { db.close(); }
    })() : { qa: [], qaSessions: 0 };
    return { run, operations: run ? reader.operations(run.runId, true) : [], ...details };
  } finally { reader.close(); }
}

async function invoke(project: string, provider: "claude" | "codex", phase: string, args: string[], interruptQa = false, allowPartialRecovery = false) {
  assert.ok(Date.now() < deadline, "Authorized deadline reached");
  const log = join(root, `${provider}-${phase}.log`);
  const entry: Record<string, unknown> = { provider, phase, args, log, startedAt: new Date().toISOString(), status: "running" };
  ledger.push(entry); save();
  const fd = openSync(log, "w", 0o600);
  const child = spawn(process.execPath, [cli, ...args], { cwd: project, env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", fd, fd] });
    trackStructuredLiveChild(child);
  let interrupted = false;
  const watch = interruptQa ? setInterval(() => {
    try {
      if (interrupted || !existsSync(join(project, ".rafi", "recovery.sqlite3"))) return;
      const observed = state(project);
      const activeQa = observed.operations.some(operation => operation.kind === "provider-dispatch" && operation.status === "in_progress" && (operation.intent as { role?: string }).role === "qa");
      const durableQaDispatch = observed.operations.some(operation => {
        const intent = operation.intent as { role?: string; sessionRef?: { sessionId?: string; validatedAt?: string; role?: string } };
        return operation.kind === "provider-dispatch" && operation.status === "in_progress" && intent.role === "qa"
          && intent.sessionRef?.role === "qa" && Boolean(intent.sessionRef.sessionId && intent.sessionRef.validatedAt);
      });
      // The dispatch journal is the durable identity before a completed turn is
      // published to provider-session history. Requiring it avoids testing a
      // bootstrap interruption that has no recoverable QA predecessor.
      if (!activeQa || !durableQaDispatch) return;
      const currentTicket = (observed.run as { currentTicket?: string; state?: { currentTicket?: string } } | undefined)?.currentTicket
        ?? (observed.run as { state?: { currentTicket?: string } } | undefined)?.state?.currentTicket;
      entry.interruption = { at: new Date().toISOString(), runId: observed.run?.runId, checkpoint: observed.run?.checkpoint, currentTicket };
      child.kill("SIGTERM"); interrupted = true; save();
    } catch (error) { entry.watchError = String(error); child.kill("SIGTERM"); }
  }, 75) : undefined;
  const timeout = setTimeout(() => child.kill("SIGTERM"), Math.min(900_000, Math.max(1, deadline - Date.now())));
  try {
    const code = await new Promise<number | null>((resolveClose, reject) => { child.once("error", reject); child.once("close", resolveClose); });
    Object.assign(entry, { code, interrupted, status: code === 0 || (interruptQa && interrupted && code === 2) || (allowPartialRecovery && code === 2) ? "pass" : "fail", finishedAt: new Date().toISOString() }); save();
    assert.equal(Boolean(entry.watchError), false, `QA observation failed; see ${log}`);
    assert.ok(code === 0 || (interruptQa && interrupted && code === 2) || (allowPartialRecovery && code === 2), `${phase} exited ${code}; see ${log}`);
    if (interruptQa) assert.equal(interrupted, true, `QA interruption was not exercised; see ${log}`);
    return entry;
  } finally { clearInterval(watch); clearTimeout(timeout); closeSync(fd); }
}

function assertPartial(project: string, runId: string) {
  const observed = state(project); const run = observed.run!;
  assert.equal(run.runId, runId, "First resume must retain the original run");
  assert.equal(run.status, "recoverable", "A completed targeted branch must leave the original remaining scope recoverable");
  assert.deepEqual(run.progress.completedTickets, ["T001"]);
  assert.deepEqual(run.progress.remainingTickets, ["T002"]);
  assert.equal(run.currentTicket, "T002");
  assert.ok(observed.qa.some(head => head.ticketId === "T001" && ["completed", "waived"].includes(head.state)), "T001 needs terminal QA evidence");
  assert.ok(!observed.qa.some(head => head.ticketId === "T002" && ["completed", "waived"].includes(head.state)), "T002 must remain untouched before public continuation");
}

function assertComplete(project: string, runId: string) {
  const observed = state(project); const run = observed.run!;
  assert.equal(run.runId, runId); assert.equal(run.status, "completed");
  assert.deepEqual(run.progress.completedTickets, ["T001", "T002"]);
  assert.deepEqual(run.progress.remainingTickets, []);
  for (const id of ["T001", "T002"]) assert.ok(observed.qa.some(head => head.ticketId === id && ["completed", "waived"].includes(head.state)), `${id} needs terminal QA evidence`);
  const sessions = new WorkflowReader(project); try {
    for (const branch of sessions.branchResumeSessions(false)) {
      if (existsSync(join(branch.worktreePath, "package.json"))) execFileSync("npm", ["test"], { cwd: branch.worktreePath, stdio: "pipe", timeout: 30_000 });
    }
  } finally { sessions.close(); }
}

try {
  for (const provider of providers) {
    const project = liveProjectPath(workspaceRoot, provider); mkdirSync(project);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: project });
    execFileSync("git", ["config", "user.name", "Rafi live canary"], { cwd: project });
    execFileSync("git", ["config", "user.email", "rafi-live@example.test"], { cwd: project });
    writeFileSync(join(project, "package.json"), JSON.stringify({ private: true, type: "module", scripts: { test: "node --test test/*.test.mjs" } }, null, 2));
    writeFileSync(join(project, "api.mjs"), "export const identity = value => value;\n");
    mkdirSync(join(project, "test"));
    writeFileSync(join(project, "test", "identity.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; import {identity} from '../api.mjs'; test('identity',()=>assert.equal(identity(3),3));\n");
    execFileSync("git", ["add", "."], { cwd: project }); execFileSync("git", ["commit", "-qm", "source baseline"], { cwd: project });
    // Use the public initializer so the later public `rafi resume` exercises a
    // fully valid Rafi project rather than a Foreman-only fixture.
    execFileSync(process.execPath, [cli, "create", ".", "--defaults", "--no-graph", "--runtime", provider, "--docs-root", "docs"], { cwd: project, stdio: "pipe", timeout: 180_000 });
    execFileSync(process.execPath, [cli, "tickets", "setup:init", "--project", project, "--defaults", "--branch-strategy", "branch-per-ticket", "--completion", "none", "--population-mode", "approved_plan"], { cwd: project, stdio: "pipe", timeout: 60_000 });
    writeFileSync(join(project, ".tickets", "tickets.yaml"), stringify({ tickets: [ticket("T001", 1, "double", "value * 2"), ticket("T002", 2, "triple", "value * 3")] }));
    cmdUpdate(project, "T001", { status: "next", actor: "canary" });
    execFileSync("git", ["add", "."] , { cwd: project }); execFileSync("git", ["commit", "-qm", "Rafi baseline"], { cwd: project });

    const start = await invoke(project, provider, "start-interrupt-qa", ["start", ".", "--agent", provider, "--steps", "2", "--yes", "--branch-per-ticket", "--completion", "none", "--keep-worktrees"], true);
    const runId = String((start.interruption as Record<string, unknown>).runId);
    assert.ok(/^[a-f0-9-]{36}$/.test(runId), "QA interruption must capture a real run id");
    await invoke(project, provider, "resume-targeted-qa", ["resume", ".", "--run", runId, "--yes"], false, true);
    assertPartial(project, runId);
    ledger.push({ provider, phase: "partial-scope-assertion", status: "pass", runId }); save();
    await invoke(project, provider, "resume-next-branch", ["resume", ".", "--run", runId, "--yes"]);
    assertComplete(project, runId);
    ledger.push({ provider, phase: "whole-scope-assertion", status: "pass", runId }); save();
  }
} catch (error) { ledger.push({ status: "fail", error: String(error), at: new Date().toISOString() }); save(); throw error; }
console.log(`Branch scope recovery passed; evidence ${root}`);

if (process.exitCode) throw new Error("Live runner recorded a failure");
});
