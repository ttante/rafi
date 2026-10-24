import { journalStructuredDispatch, nativePolicy } from "../../packages/ai-foreman/src/structuredOperation.js";
/** Production adapter conformance; the complete CLI journey is a separate gate. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { providerWireContract, ticketPopulationOutput, workReportOutput, qaVerdictOutput, contractAcceptanceOutput, handoffAcceptanceOutput, validateStructuredCandidate, type OutputContract } from "../../packages/spec/src/index.js";
import { ClaudeAdapter } from "../../packages/ai-foreman/src/adapters/claude.js";
import { CodexAdapter } from "../../packages/ai-foreman/src/adapters/codex.js";
import type { BuilderAdapter } from "../../packages/ai-foreman/src/adapters/types.js";
import { assertStructuredLiveProvidersAuditable, createStructuredRetainedEvidenceDirectory, probeConfig, providerVersions } from "./structured-output-support.mjs";
import { createLiveWorkspace } from "./workspace.mjs";

import { runSupervisedStructuredLive } from "./structured-live-supervisor.mjs";

await runSupervisedStructuredLive("structured-adapters", async (supervisor) => {
const { deadline, providers, liveValidation } = supervisor.config;
assertStructuredLiveProvidersAuditable(providers);
const { workspaceRoot: cwd, evidenceRoot } = createLiveWorkspace("structured-adapters", { evidenceRoot: supervisor.evidenceRoot });
execFileSync("git", ["init", "-q"], { cwd });
const report: Record<string, any> = { kind: "production-adapter-conformance", startedAt: new Date().toISOString(), cwd,
  versions: providerVersions(providers, execFileSync), maximumHostDispatches: providers.length * 5, turnDeadlineMs: 90_000,
  sourceHashes: Object.fromEntries(["packages/ai-foreman/src/adapters/claude.ts", "packages/ai-foreman/src/adapters/codex.ts", "packages/ai-foreman/src/adapters/structured.ts", "packages/spec/src/structuredOutput.ts", "packages/spec/src/operationContracts.ts", "packages/spec/src/qaOutputContracts.ts"].map(path => [path, createHash("sha256").update(readFileSync(path)).digest("hex")])), results: [], events: [] };
const save = () => writeFileSync(join(evidenceRoot, "results.json"), JSON.stringify(report, null, 2));
console.log(`Production adapter evidence: ${evidenceRoot}`); save();
for (const provider of providers) {
  if (provider !== "claude" && provider !== "codex") throw new Error("Unknown provider");
  let adapter: BuilderAdapter | undefined;
  let viewer: Promise<void> | undefined;
  try {
    if (Date.now() >= deadline) throw new Error("Live deadline exhausted");
    const opts = { cwd, queryBudget: supervisor, runtimeExecutable: provider === "claude" ? process.env.RAFI_LIVE_CLAUDE_EXECUTABLE ?? "claude" : "codex",
      model: provider === "claude" ? process.env.RAFI_LIVE_CLAUDE_MODEL ?? "sonnet" : process.env.RAFI_LIVE_CODEX_MODEL,
      permission: async () => ({ behavior: "deny" as const, message: "No domain tools in this serialization fixture" }),
      turnDeadlineMs: Math.min(90_000, deadline - Date.now()), providerIdleTimeoutMs: 90_000, shutdownTimeoutMs: 10_000 };
    adapter = provider === "claude" ? await ClaudeAdapter.create(opts) : new CodexAdapter(opts);
    const active: BuilderAdapter = adapter;
    supervisor.track(() => active.close());
    viewer = (async () => { for await (const event of active.events()) { report.events.push({ provider, event }); save(); } })();
    const contracts: OutputContract<any>[] = [ticketPopulationOutput, workReportOutput, qaVerdictOutput, contractAcceptanceOutput, handoffAcceptanceOutput];
    const expected = [{ version: 1, operation: "ticket-population", result: { kind: "completed", summary: "Serialization fixture only", payload: { version: 1, plan_id: "fixture", revision: 1, tickets: [], retirements: [] } }, continuity: null }];
    const envelope = (operation: string, payload: unknown) => ({ version: 1, operation, result: { kind: "completed", summary: "Serialization fixture only", payload }, continuity: null });
    expected.push(envelope("work-report", { disposition: "already-satisfied", evidence: ["No source changes requested"], coverage: null, graphMaintenance: null }) as any,
      envelope("qa-verdict", { kind: "passed", coverage: null, verifiedInstructionIds: [] }) as any,
      envelope("qa-contract-acceptance", { workId: "fixture", revision: 1, digest: "a".repeat(64), missingSections: [] }) as any,
      envelope("handoff-acceptance", { manifestDigest: "b".repeat(64), generation: 1, missingResources: [] }) as any);
    const ticketWire = provider === "codex"
      ? { version: 1, operation: "ticket-population", kind: "completed", summary: "Serialization fixture only", payload: expected[0]!.result.payload,
        reason: null, nextAction: null, question: null, choices: [], continuity: null }
      : expected[0];
    const providerValues = [ticketWire, ...expected.slice(1)];
    // Verify the harness itself has selected a registered wire before asking a
    // live provider to honor it.
    for (const contract of contracts) providerWireContract(contract, provider, "default", { requireRegistered: true });
    const prompts = providerValues.map(value => `Serialization fixture only. This is not real work or a real QA verdict. No tools. Return this exact selected wire value: ${JSON.stringify(value)}`);
    let session: string | undefined;
    for (let i = 0; i < contracts.length; i++) {
      if (Date.now() >= deadline) throw new Error("Live deadline exhausted");
      const started = performance.now();
      const wireContract = providerWireContract(contracts[i]!, provider, "default", { requireRegistered: true });
      const turn = await journalStructuredDispatch(cwd, adapter, prompts[i]!, nativePolicy(contracts[i]!, { wireContract, responseOnly: true, purpose: "response-repair" }),
        (text, policy) => active.sendTurn(text, policy));
      report.results.push({ provider, operation: contracts[i]!.operation, elapsedMs: performance.now() - started, turn }); save();
      assert.equal(turn.isError, false, JSON.stringify(turn));
      assert.deepEqual(validateStructuredCandidate(contracts[i]!, turn.structured, providerWireContract(contracts[i]!, provider), turn.selectedDispatch!), expected[i]);
      if (session) assert.equal(adapter.sessionId(), session); else session = adapter.sessionId();
      console.log(`${provider}: ${contracts[i]!.operation} passed`);
    }
  } catch (error) { report.failures ??= []; report.failures.push({ provider, error: String(error) }); process.exitCode = 1; }
  finally { await adapter?.close(); await viewer; save(); }
}
report.finishedAt = new Date().toISOString(); save();

if (process.exitCode) throw new Error("Structured live runner recorded a failure");
});
