/** Opt-in live fast-mode canaries; no tools and only disposable directories. */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeAdapter } from "../../packages/ai-foreman/src/adapters/claude.js";
import { CodexAdapter } from "../../packages/ai-foreman/src/adapters/codex.js";
import type { BuilderAdapterOptions } from "../../packages/ai-foreman/src/adapters/types.js";
import { createLiveWorkspace } from "./workspace.mjs";

import { runSupervisedStructuredLive } from "./structured-live-supervisor.mjs";

await runSupervisedStructuredLive("fast-mode", async (supervisor) => {
if (process.env.RAFI_LIVE_FAST_MODE !== "1") throw new Error("Set RAFI_LIVE_FAST_MODE=1 after authorizing live provider usage.");
const liveWorkspace = createLiveWorkspace("rafi-live-fast-mode-");
const root = liveWorkspace.evidenceRoot;
const workspaceRoot = liveWorkspace.workspaceRoot;
console.log(`Live artifacts: ${root}`);
const results: unknown[] = [];
const providers = (process.env.RAFI_LIVE_PROVIDERS ?? "claude,codex").split(",");
if (providers.some(provider => !["claude", "codex"].includes(provider))) throw new Error("Unknown live provider");
const input = "Reply exactly FAST_MODE_OK. Do not use tools, inspect files, or run commands.";
const options: BuilderAdapterOptions = { cwd: workspaceRoot, configRoot: workspaceRoot, fast: true, permission: async () => ({ behavior: "deny", message: "Live canary forbids tools" }), sandboxMode: "read-only", preparationTimeoutMs: 60_000, rpcTimeoutMs: 30_000, turnDeadlineMs: 120_000, providerIdleTimeoutMs: 60_000 };
const save = () => writeFileSync(join(root, "results.json"), JSON.stringify(results, null, 2));
try {
  if (providers.includes("claude")) {
    const adapter = await ClaudeAdapter.create({ ...options, model: process.env.RAFI_LIVE_CLAUDE_MODEL ?? "sonnet" });
    const internal = adapter as unknown as { handle(message: { type: string; model?: string }): void; fastModeEnabled: boolean };
    const original = internal.handle.bind(adapter);
    const reportedModels: string[] = [];
    internal.handle = message => { if (message.type === "system" && message.model) reportedModels.push(message.model); original(message); };
    try {
      const ref = await adapter.prepareSession();
      const started = performance.now();
      const result = await adapter.sendTurn(input, { responseOnly: true });
      assert.equal(result.isError, false, result.text);
      assert.match(result.text, /FAST_MODE_OK/);
      assert.equal(adapter.sessionId(), ref.sessionId);
      const model = process.env.RAFI_LIVE_CLAUDE_MODEL ?? "sonnet";
      if (["sonnet", "opus", "haiku"].includes(model)) assert.ok(reportedModels.length > 0 && reportedModels.every(reported => reported.includes(model)), "Fast preference changed the Claude model");
      results.push({ provider: "claude", scenario: "model-capability-check", model, reportedModels, fastEnabled: internal.fastModeEnabled, sessionPreserved: true, seconds: (performance.now() - started) / 1000, result: result.text });
      save();
    } finally { await adapter.close(); }
  }
  if (providers.includes("codex")) for (const scenario of ["native-fast", "capability-unavailable", "injected-tier-rejection"] as const) {
    const adapter = new CodexAdapter({ ...options, model: process.env.RAFI_LIVE_CODEX_MODEL });
    const internal = adapter as unknown as { request(method: string, params: Record<string, unknown>): Promise<unknown> };
    const original = internal.request.bind(adapter);
    const tiers: unknown[] = []; const models: unknown[] = [];
    internal.request = async (method, params) => {
      if (method === "turn/start") { tiers.push(params.serviceTier); models.push(params.model); }
      if (method === "turn/start" && scenario === "injected-tier-rejection" && tiers.length === 1) throw new Error("service_tier priority is not supported for this model");
      const result = await original(method, params);
      if (method === "model/list" && scenario !== "native-fast") {
        // The installed server silently ignores unknown tiers. Simulate a
        // provider rejection at the RPC boundary, then validate the fallback
        // with a real authenticated standard-speed model turn.
        const catalog = result as { data: Array<Record<string, unknown>> };
        return { ...catalog, data: catalog.data.map(model => ({ ...model, serviceTiers: scenario === "capability-unavailable" ? [] : [{ id: "priority", name: "Fast" }], additionalSpeedTiers: [] })) };
      }
      return result;
    };
    try {
      const ref = await adapter.prepareSession();
      const started = performance.now();
      const result = await adapter.sendTurn(input, { responseOnly: true });
      assert.equal(result.isError, false, result.text);
      assert.match(result.text, /FAST_MODE_OK/);
      assert.equal(adapter.sessionId(), ref.sessionId);
      if (scenario === "capability-unavailable") assert.deepEqual(tiers, ["default"]);
      if (scenario === "injected-tier-rejection") assert.deepEqual(tiers, ["priority", "default"]);
      assert.ok(models.every(model => model === models[0]), "Fallback changed models");
      results.push({ provider: "codex", scenario, sessionPreserved: true, modelUnchanged: true, tiers, seconds: (performance.now() - started) / 1000, result: result.text });
      save();
    } finally { await adapter.close(); }
  }
  console.log(JSON.stringify({ passed: results.length, results }));
} catch (error) { results.push({ failure: String(error) }); save(); throw error; }

if (process.exitCode) throw new Error("Live runner recorded a failure");
});
