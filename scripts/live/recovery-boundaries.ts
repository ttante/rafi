/** Opt-in authenticated canaries. Only disposable projects are modified. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeAdapter } from "../../packages/ai-foreman/src/adapters/claude.js";
import { CodexAdapter } from "../../packages/ai-foreman/src/adapters/codex.js";
import { HandoffService } from "../../packages/ai-foreman/src/handoffs.js";
import { WorkflowDb } from "../../packages/ai-foreman/src/workflowDb.js";
import { PermissionPolicy } from "../../packages/ai-foreman/src/permissions/policy.js";
import { DEFAULT_CONFIG } from "../../packages/ai-foreman/src/config.js";
import type { BuilderAdapter, BuilderAdapterOptions } from "../../packages/ai-foreman/src/adapters/types.js";
import type { ContinuityDelta } from "../../packages/spec/src/index.js";
import { createLiveWorkspace, liveProjectPath } from "./workspace.mjs";

import { runSupervisedStructuredLive } from "./structured-live-supervisor.mjs";

await runSupervisedStructuredLive("recovery-boundaries", async (supervisor) => {
if (process.env.RAFI_LIVE_RECOVERY !== "1") throw new Error("Explicit provider authorization and RAFI_LIVE_RECOVERY=1 are required.");
const providers = (process.env.RAFI_LIVE_PROVIDERS ?? "claude,codex").split(",");
if (providers.some(provider => !["claude", "codex"].includes(provider))) throw new Error("Unknown provider");
const liveWorkspace = createLiveWorkspace("rafi-live-recovery-");
const root = liveWorkspace.evidenceRoot;
const workspaceRoot = liveWorkspace.workspaceRoot;
console.log(`Live evidence: ${root}`);
const startedAt = Date.now();
const deadline = Math.min(startedAt + 3 * 60 * 60_000, process.env.RAFI_LIVE_DEADLINE ? Date.parse(process.env.RAFI_LIVE_DEADLINE) : startedAt + Number(process.env.RAFI_LIVE_BUDGET_MS ?? 3 * 60 * 60_000));
if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new Error("Invalid or expired authorized live deadline");
const records: unknown[] = [];
const save = () => writeFileSync(join(root, "results.json"), JSON.stringify({ profile: "both", providers, model: "provider default", startedAt: new Date(startedAt).toISOString(), deadline: new Date(deadline).toISOString(), records }, null, 2));
function fixture(name: string): string {
  const dir = liveProjectPath(workspaceRoot, name); mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "sentinel.txt"), "PRESERVE_THIS\n");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}
async function create(provider: string, dir: string, resume?: BuilderAdapterOptions["resumeSessionRef"]): Promise<BuilderAdapter> {
  if (Date.now() >= deadline) throw new Error("Authorized live budget exhausted");
  const policy = new PermissionPolicy(DEFAULT_CONFIG.permissions, dir, { currentBranchWorkflow: true });
  const options: BuilderAdapterOptions = { cwd: dir, configRoot: dir, sessionRole: "builder", sessionStream: "builder", networkAccess: false,
    preparationTimeoutMs: 90_000, rpcTimeoutMs: 60_000, providerIdleTimeoutMs: 120_000, turnDeadlineMs: Math.min(240_000, deadline - Date.now()),
    ...(resume ? { resumeSessionRef: resume } : {}),
    onLifecycleTrace: trace => { writeFileSync(join(dir, "lifecycle.jsonl"), `${JSON.stringify(trace)}\n`, { flag: "a" }); },
    permission: async request => policy.classify(request).decision === "allow" ? { behavior: "allow" } : { behavior: "deny", message: "Live fixture permits only configured project-local operations" },
  };
  return provider === "claude" ? ClaudeAdapter.create(options) : new CodexAdapter(options);
}
const delta: ContinuityDelta = { version: 1, decisions: [], constraints: ["Preserve sentinel.txt"], discoveries: [], completedActions: [], evidence: [], failures: [], blockers: [], openWork: ["Implement the next host assignment"], nextAction: "Wait for the host assignment" };
try {
  save();
  for (const provider of providers) {
    const dir = fixture(`${provider}-cwd`);
    writeFileSync(join(dir, "src/test_basic.py"), "import unittest\nclass Arithmetic(unittest.TestCase):\n def test_add(self): self.assertEqual(2 + 3, 5)\n");
    execFileSync("python3", ["-m", "venv", "--without-pip", join(dir, ".venv")], { timeout: 30_000 });
    let adapter = await create(provider, dir);
    let events: unknown[] = [];
    let consume = (async () => { for await (const event of adapter.events()) events.push(event); })();
    try {
      const ref = await adapter.prepareSession!();
      const first = await adapter.sendTurn("Use Bash (or the native shell tool) to run exactly: cd src && PYTHONPATH=. python3 -m unittest test_basic 2>&1. After it succeeds reply CWD_OK. Do not edit files or run any other command.");
      assert.equal(first.isError, false, first.text); assert.match(first.text, /CWD_OK/);
      const write = await adapter.sendTurn(`Use Write or the native file edit tool to create exactly ${join(dir, "nested-write.txt")} with content CWD_WRITE_OK followed by a newline. This is an explicitly authorized disposable fixture write after the Bash directory change. Do not edit any other file or use shell commands. Then reply WRITE_OK.`);
      assert.equal(write.isError, false, write.text); assert.match(write.text, /WRITE_OK/);
      assert.equal(readFileSync(join(dir, "nested-write.txt"), "utf8"), "CWD_WRITE_OK\n");
      records.push({ provider, scenario: "cwd-followup-file-write", status: "pass" }); save();
      const virtualenv = await adapter.sendTurn(`Run the existing project virtualenv Python to execute the same unittest. Use the literal command PYTHONPATH=${join(dir, "src")} ${join(dir, ".venv/bin/python")} -m unittest test_basic 2>&1. After success reply VENV_OK. Do not edit files, install packages, or run other commands.`);
      assert.equal(virtualenv.isError, false, virtualenv.text); assert.match(virtualenv.text, /VENV_OK/);
      records.push({ provider, scenario: "project-test-shell-forms-and-existing-venv", status: "pass" }); save();
      const second = await adapter.sendTurn("Reply exactly SECOND_TURN_OK. Do not use tools.", { responseOnly: true });
      assert.equal(second.isError, false, second.text); assert.match(second.text, /SECOND_TURN_OK/);
      assert.equal(adapter.sessionRef?.()?.cwd, ref.cwd); assert.equal(adapter.sessionId(), ref.sessionId);
      records.push({ provider, scenario: "cwd-followup-turns", status: "pass", sessionId: ref.sessionId }); save();
      await adapter.close(); await consume;
      writeFileSync(join(dir, "events.json"), JSON.stringify(events, null, 2));
      adapter = await create(provider, dir, ref); events = [];
      consume = (async () => { for await (const event of adapter.events()) { events.push(event); writeFileSync(join(dir, "resume-events.json"), JSON.stringify(events, null, 2)); } })();
      await adapter.prepareSession!();
      const resumed = await adapter.sendTurn("Reply exactly RESUMED_CWD_OK. Do not use tools.", { responseOnly: true });
      assert.equal(resumed.isError, false, resumed.text); assert.match(resumed.text, /RESUMED_CWD_OK/);
      assert.equal(adapter.sessionId(), ref.sessionId);
      assert.equal(readFileSync(join(dir, "sentinel.txt"), "utf8"), "PRESERVE_THIS\n");
      records.push({ provider, scenario: "cwd-followup-turns-and-resume", status: "pass", sessionId: ref.sessionId }); save();
    } finally { await adapter.close(); await consume; }
    for (let seed = 1; seed <= 3; seed++) {
      const project = fixture(`${provider}-handoff-${seed}`);
      const db = new WorkflowDb(project);
      const runId = `${provider}-handoff-${seed}`;
      db.ensureRun(runId); db.publishContinuityCheckpoint({ runId, role: "builder", delta, authoritativeStateRevision: 1 }); db.close();
      const successor = await create(provider, project);
      await successor.prepareSession!();
      const events: Array<{ kind: string }> = [];
      const consume = (async () => { for await (const event of successor.events()) events.push(event); })();
      try {
        const transfer = await new HandoffService(project).transfer({ runId, role: "builder", reason: "Live interrupted-build recovery acceptance", compactionCount: 0, compactMaximum: 10 }, async () => successor, { choose: async error => { throw error; } });
        assert.ok(transfer.acceptanceCheckpointDigest); assert.ok(transfer.acceptanceReceipt);
        assert.equal(events.filter(event => event.kind === "tool").length, 0, "Acceptance attempted tools");
        assert.equal(readFileSync(join(project, "sentinel.txt"), "utf8"), "PRESERVE_THIS\n");
        records.push({ provider, scenario: "real-host-handoff", seed, status: "pass", acceptanceCheckpointDigest: transfer.acceptanceCheckpointDigest }); save();
      } finally { await successor.close(); await consume; writeFileSync(join(project, "events.json"), JSON.stringify(events, null, 2)); }
    }
  }
} catch (error) { records.push({ status: "fail", error: String(error) }); save(); throw error; }
console.log(JSON.stringify({ results: records }));

if (process.exitCode) throw new Error("Live runner recorded a failure");
});
