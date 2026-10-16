/** Opt-in native control evidence; no application mutation or paid model turn. */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "../../packages/ai-foreman/src/adapters/claude.js";
import { resolveExecutablePath } from "../../packages/ai-foreman/src/runtimeReadiness.js";
if (process.env.RAFI_LIVE_COMPACTION !== "1") throw new Error("Explicit online authorization is required");
const deadline = Date.parse(process.env.RAFI_LIVE_DEADLINE ?? "");
if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new Error("Authorized deadline is required");
const root = mkdtempSync(join(tmpdir(), "rafi-live-compaction-"));
console.log(`Compaction control evidence: ${root}`);
const controls: unknown[] = [];
const outcomes: unknown[] = [];
const variants = process.env.RAFI_LIVE_COMPACTION_COMPARE_LAUNCH === "1" ? ["runtime", "launch"] : ["runtime"];
const save = () => writeFileSync(join(root, "controls.json"), JSON.stringify({ deadline: new Date(deadline).toISOString(), controls, outcomes }, null, 2));
for (const variant of variants) {
  if (Date.now() >= deadline - 60_000) throw new Error("Insufficient authorized time for control probe and cleanup");
  const cwd = join(root, variant); mkdirSync(cwd);
  let runtimeExecutable: string | undefined;
  if (variant === "launch") {
    const executable = resolveExecutablePath("claude");
    if (!executable) throw new Error("Native Claude executable unavailable");
    runtimeExecutable = join(root, "claude-launch-window");
    const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
    // A disposable wrapper adds the documented nonpersistent CLI flag only.
    // Account/project settings files and environment overrides are untouched.
    writeFileSync(runtimeExecutable, `#!/bin/sh\nexec ${quote(executable)} --autocompact 683000 "$@"\n`, { mode: 0o700 });
    chmodSync(runtimeExecutable, 0o700);
  }
  const adapter = await ClaudeAdapter.create({ cwd, runtimeExecutable, sessionRole: "builder", preparationTimeoutMs: 60_000, rpcTimeoutMs: 30_000, permission: async () => ({ behavior: "deny", message: "Local control diagnostic only" }) });
  const query = (adapter as unknown as { query: { applyFlagSettings(settings: unknown): Promise<unknown>; getContextUsage(): Promise<unknown> } }).query;
  let measurement = "initial";
  const apply = query.applyFlagSettings.bind(query), usage = query.getContextUsage.bind(query);
  query.applyFlagSettings = async settings => { controls.push({ variant, kind: "request", settings }); const result = await apply(settings); controls.push({ variant, kind: "ack", result }); return result; };
  query.getContextUsage = async () => {
    const result = await usage();
    const fields = result as Record<string, unknown>;
    controls.push({ variant, measurement, kind: "usage", result: Object.fromEntries(["model", "maxTokens", "rawMaxTokens", "autoCompactWindow", "autoCompactThreshold", "isAutoCompactEnabled", "autocompactSource", "totalTokens"].map(key => [key, fields[key]])) });
    return result;
  };
  const consume = (async () => { for await (const _event of adapter.events()) { /* drain owned stream */ } })();
  try {
    await adapter.prepareSession(); // Advertised local /context; no model request.
    if (variant === "runtime") {
      const policy = await adapter.prepareAutoCompaction(65);
      outcomes.push({ variant, status: "pass", policy });
      measurement = "after-local-context";
      const barrier = await adapter.sendTurn("/context", { responseOnly: true });
      assert.equal(barrier.isError, false);
      assert.equal(barrier.numTurns, 0, "The advertised local context barrier must use zero model turns");
      await query.getContextUsage();
      measurement = "after-bounded-delay";
      await new Promise(resolve => setTimeout(resolve, 1500));
      await query.getContextUsage();
    } else {
      await query.getContextUsage();
      outcomes.push({ variant, status: "pass", requestedLaunchWindow: 683000 });
    }
    save();
  } catch (error) { outcomes.push({ variant, status: "fail", error: String(error) }); save(); throw error; }
  finally { await adapter.close(); await consume; }
}
console.log(JSON.stringify({ outcomes, controls }));
