/** Native auto-allow routing reproduction/retest in disposable projects. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ClaudeAdapter } from "../../packages/ai-foreman/src/adapters/claude.js";
import { createLiveWorkspace, liveProjectPath } from "./workspace.mjs";
if (process.env.RAFI_LIVE_RECOVERY !== "1") throw new Error("Explicit live authorization required");
const deadline = Date.parse(process.env.RAFI_LIVE_DEADLINE ?? "");
if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new Error("Approved deadline is missing or expired");
const liveWorkspace = createLiveWorkspace("rafi-live-policy-routing-");
const root = liveWorkspace.evidenceRoot;
const workspaceRoot = liveWorkspace.workspaceRoot;
console.log(`Permission evidence: ${root}`);
const records: unknown[] = [];
try {
  for (const hostAllows of [false, true]) {
    const project = liveProjectPath(workspaceRoot, hostAllows ? "host-allow" : "host-deny"); mkdirSync(join(project, ".claude"), { recursive: true });
    writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash"] } }));
    const requests: string[] = [];
    const events: unknown[] = [];
    const adapter = await ClaudeAdapter.create({ cwd: project, configRoot: project, sessionRole: "builder", networkAccess: false,
      preparationTimeoutMs: 60_000, turnDeadlineMs: Math.min(120_000, deadline - Date.now()),
      permission: async request => { requests.push(request.toolName); return hostAllows && request.toolName === "Bash" ? { behavior: "allow" } : { behavior: "deny", message: "Rafi host policy denies this exact test operation" }; },
    });
    const consume = (async () => { for await (const event of adapter.events()) { events.push(event); writeFileSync(join(project, "events.json"), JSON.stringify(events, null, 2)); } })();
    try {
      await adapter.prepareSession();
      const result = await adapter.sendTurn(`Use Bash to run exactly: python3 -c 'from pathlib import Path; Path("host-policy-probe.txt").write_text("PROBE")'. Do not use any other tool. If permission is denied, do not retry; reply BLOCKED. Otherwise reply PROBE_DONE.`);
      assert.equal(result.isError, false, result.text);
      const wrote = existsSync(join(project, "host-policy-probe.txt"));
      records.push({ hostAllows, hostPermissionCalls: requests.length, requests, wrote, result: result.text });
      writeFileSync(join(root, "results.json"), JSON.stringify(records, null, 2));
      if (hostAllows) assert.equal(wrote, true, "Allowed project operation was blocked");
      else if (process.env.RAFI_LIVE_POLICY_EXPECTED === "blocked") { assert.equal(wrote, false, "Native auto-allow bypassed Rafi policy"); assert.ok(requests.includes("Bash"), "Host policy was not consulted"); }
    } finally { await adapter.close(); await consume; }
  }
} catch (error) { records.push({ error: String(error) }); writeFileSync(join(root, "results.json"), JSON.stringify(records, null, 2)); throw error; }
console.log(JSON.stringify(records));
