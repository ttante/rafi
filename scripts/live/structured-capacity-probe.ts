/**
 * A deliberately small, provider-native experiment used to classify a
 * structured-output capacity failure.  It never exercises a Rafi workflow or
 * publishes state: the fixture asks a provider to echo a tiny, completed
 * artifact through a selected, flat wire contract.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { createProviderWireContract, operationContract, projectCodexSchema, validateStructuredCandidate } from "../../packages/spec/src/index.js";
import { ClaudeAdapter } from "../../packages/ai-foreman/src/adapters/claude.js";
import { CodexAdapter } from "../../packages/ai-foreman/src/adapters/codex.js";
import type { BuilderAdapter } from "../../packages/ai-foreman/src/adapters/types.js";
// @ts-expect-error shared bounded harness is plain JS
import { probeConfig, providerVersions } from "./structured-output-support.mjs";
// @ts-expect-error shared workspace harness is plain JS
import { createLiveWorkspace } from "./workspace.mjs";

const maxTickets = Number.parseInt(process.env.RAFI_LIVE_CAPACITY_MAX_TICKETS ?? "1", 10);
if (!Number.isSafeInteger(maxTickets) || maxTickets < 0 || maxTickets > 200) throw new Error("RAFI_LIVE_CAPACITY_MAX_TICKETS must be an integer from 0 to 200");
const { deadline, providers } = probeConfig();
const { workspaceRoot: cwd, evidenceRoot } = createLiveWorkspace("structured-capacity-probe");
execFileSync("git", ["init", "-q"], { cwd });

const ticket = z.strictObject({ id: z.string().min(1).max(64), title: z.string().min(1).max(500), acceptance: z.array(z.string().min(1).max(500)).max(5) });
const payload = z.strictObject({ tickets: z.array(ticket).max(maxTickets) });
const contract = operationContract("ticket-capacity-probe", payload, { graph: false });
const wireSchema = z.toJSONSchema(z.strictObject({ version: z.literal(1), operation: z.literal("ticket-capacity-probe"), summary: z.string().min(1).max(200), payload, continuity: z.null() }), { target: "draft-7", io: "input" }) as Record<string, unknown>;
const fixture = { version: 1, operation: "ticket-capacity-probe", summary: "Capacity fixture", payload: { tickets: [] }, continuity: null };
const canonical = { version: 1, operation: "ticket-capacity-probe", result: { kind: "completed", summary: fixture.summary, payload: fixture.payload }, continuity: null };
const report: Record<string, unknown> = { kind: "structured-capacity-probe", maxTickets, startedAt: new Date().toISOString(), cwd,
  versions: providerVersions(providers, execFileSync), results: [], failures: [] };
const save = () => writeFileSync(join(evidenceRoot, "results.json"), JSON.stringify(report, null, 2));

for (const provider of providers) {
  let adapter: BuilderAdapter | undefined;
  try {
    if (Date.now() >= deadline) throw new Error("Live deadline exhausted");
    const wire = createProviderWireContract({
      canonical: contract, provider, profile: `${provider}-ticket-capacity-probe-v1`, variant: `max-${maxTickets}`, wireVersion: 1,
      wireSchema: provider === "codex" ? projectCodexSchema(wireSchema) as Record<string, unknown> : wireSchema,
      maximumSchemaBytes: 100_000, maximumResponseBytes: 100_000, maximumPageBytes: 100_000,
      normalizerId: "ticket-capacity-probe-v1", normalizerVersion: 1,
      normalize: value => {
        const parsed = z.strictObject({ version: z.literal(1), operation: z.literal("ticket-capacity-probe"), summary: z.string().min(1).max(200), payload, continuity: z.null() }).parse(value);
        return { version: 1, operation: "ticket-capacity-probe", result: { kind: "completed", summary: parsed.summary, payload: parsed.payload }, continuity: null };
      },
      guidanceId: "ticket-capacity-probe-v1", guidance: () => "Return exactly the selected flat JSON wire value.",
    });
    const opts = { cwd, runtimeExecutable: provider === "claude" ? process.env.RAFI_LIVE_CLAUDE_EXECUTABLE ?? "claude" : "codex",
      model: provider === "claude" ? process.env.RAFI_LIVE_CLAUDE_MODEL ?? "sonnet" : process.env.RAFI_LIVE_CODEX_MODEL,
      permission: async () => ({ behavior: "deny" as const, message: "No tools in capacity probe" }), turnDeadlineMs: Math.min(90_000, deadline - Date.now()), providerIdleTimeoutMs: 90_000, shutdownTimeoutMs: 10_000 };
    adapter = provider === "claude" ? await ClaudeAdapter.create(opts) : new CodexAdapter(opts);
    const turn = await adapter.sendTurn(`Serialization fixture only. No tools. Return this exact selected wire value: ${JSON.stringify(fixture)}`, {
      output: contract, wireContract: wire, responseOnly: true, purpose: "response-repair", dispatchId: randomUUID(),
    });
    (report.results as unknown[]).push({ provider, turn }); save();
    assert.equal(turn.isError, false, JSON.stringify(turn));
    assert.deepEqual(validateStructuredCandidate(contract, turn.structured, wire), canonical);
    console.log(`${provider}: maxTickets=${maxTickets} passed`);
  } catch (error) {
    (report.failures as unknown[]).push({ provider, error: String(error) }); process.exitCode = 1;
  } finally { await adapter?.close(); save(); }
}
report.finishedAt = new Date().toISOString();
save();
console.log(`Capacity probe evidence: ${evidenceRoot}`);
