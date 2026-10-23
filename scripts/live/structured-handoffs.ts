import { resolveQaPreparationConfig } from "../../packages/ai-foreman/src/qaPreparationPolicy.js";
/** Actual handoff, segmented contract delivery and native compaction boundaries.
 * Synthetic authorized work only; never treat this as independent product QA. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { initializationOutput, workReportOutput } from "../../packages/spec/src/index.js";
import { ClaudeAdapter } from "../../packages/ai-foreman/src/adapters/claude.js";
import { CodexAdapter } from "../../packages/ai-foreman/src/adapters/codex.js";
import type { BuilderAdapter, BuilderAdapterOptions } from "../../packages/ai-foreman/src/adapters/types.js";
import { WorkflowDb } from "../../packages/ai-foreman/src/workflowDb.js";
import { HandoffService } from "../../packages/ai-foreman/src/handoffs.js";
import { ContinuityAdapter, baselineContinuityDelta } from "../../packages/ai-foreman/src/continuity.js";
import { nativePolicy, operationPayload } from "../../packages/ai-foreman/src/structuredOperation.js";
import { deliverVerificationContract, actualContractSession, assertContractReceipt } from "../../packages/ai-foreman/src/qaContractDelivery.js";
import { assembleContract } from "../../packages/ai-foreman/src/qaVerificationContract.js";
import { candidate, assessment } from "../../packages/ai-foreman/test/qaPreparationFixtures.js";
// @ts-expect-error bounded shared live harness
import { probeConfig, providerVersions } from "./structured-output-support.mjs";
// @ts-expect-error bounded shared live harness
import { createLiveWorkspace } from "./workspace.mjs";
const { providers, deadline } = probeConfig();
const { workspaceRoot: root, evidenceRoot } = createLiveWorkspace("structured-handoffs");
const report: Record<string, any> = { kind: "production-boundary-conformance", startedAt: new Date().toISOString(), deadline, versions: providerVersions(providers, execFileSync), results: [], events: [],
  sourceHashes: Object.fromEntries(["continuity", "handoffs", "qaContractDelivery", "structuredOperation"].map(name => [name, createHash("sha256").update(readFileSync(`packages/ai-foreman/src/${name}.ts`)).digest("hex")])) };
const save = () => writeFileSync(join(evidenceRoot, "results.json"), JSON.stringify(report, null, 2));
console.log(`Production boundary evidence: ${evidenceRoot}`); save();
for (const provider of providers) {
  const cwd = join(root, provider); execFileSync("git", ["init", "-q", cwd]);
  const db = new WorkflowDb(cwd), adapters: BuilderAdapter[] = [], pumps: Promise<void>[] = [];
  let dispatches = 0;
  const checkDeadline = () => { if (Date.now() >= deadline) throw new Error("Live boundary deadline expired"); };
  const create = async () => {
    checkDeadline();
    const options: BuilderAdapterOptions = { cwd, configRoot: cwd, sessionRole: "builder", sessionStream: "builder", sessionGeneration: 0,
      runtimeExecutable: provider === "claude" ? process.env.RAFI_LIVE_CLAUDE_EXECUTABLE ?? "claude" : "codex",
      model: provider === "claude" ? process.env.RAFI_LIVE_CLAUDE_MODEL ?? "sonnet" : process.env.RAFI_LIVE_CODEX_MODEL,
      permission: async () => ({ behavior: "deny", message: "Transport boundary fixture: no domain tools authorized" }),
      turnDeadlineMs: Math.min(90000, deadline - Date.now()), providerIdleTimeoutMs: 90000, shutdownTimeoutMs: 10000 };
    const adapter = provider === "claude" ? await ClaudeAdapter.create(options) : new CodexAdapter(options);
    const send = adapter.sendTurn.bind(adapter);
    adapter.sendTurn = (instruction, policy) => { checkDeadline(); if (++dispatches > 12) throw new Error("Boundary dispatch budget exhausted"); return send(instruction, policy); };
    adapters.push(adapter);
    pumps.push((async () => { for await (const event of adapter.events()) { report.events.push({ provider, event }); save(); } })());
    return adapter;
  };
  try {
    const old = await create();
    const initialized = await old.sendTurn("Synthetic transport test. No tools. Submit completed session-initialization with payload {ready:true}, summary 'Ready', and null continuity.", nativePolicy(initializationOutput, { responseOnly: true, purpose: "initialization" }));
    assert.deepEqual(operationPayload(initialized, initializationOutput), { ready: true });
    const originalSession = old.sessionRef()!; assert.ok(originalSession);
    db.ensureRun("run");
    const admission = db.admitWork({ runId: "run", kind: "ticket", ticketId: "T1", definition: { id: "T1", summary: "Synthetic communication boundary test; no product changes authorized" }, approvalId: "live-fixture", scopeRevision: "1", provenance: { userTurn: "Run live end-to-end communication tests", reason: "Disposable transport fixture" } });
    db.publishContinuityCheckpoint({ runId: "run", role: "builder", delta: baselineContinuityDelta("Continue the synthetic transport fixture without product work"), authoritativeStateRevision: 1, sessionRef: originalSession });
    db.claimInitialRoleLease("run", "builder", originalSession);
    const transferred = await new HandoffService(cwd).transfer({ runId: "run", role: "builder", reason: "Explicit live handoff boundary test", predecessorSessionId: originalSession.sessionId, predecessorSessionRef: originalSession, compactionCount: 0, compactMaximum: 10,
      resources: [{ label: "authorized-fixture", authoritative: true, requiredForRecovery: true, content: "Only synthetic communication verification is authorized. No implementation or domain tools.", purpose: "Exact authorized remaining work", mediaType: "text/plain" }] }, create);
    assert.notEqual(transferred.successorSessionId, originalSession.sessionId);
    assert.equal(db.roleMutationLease("run", "builder")?.providerSessionId, transferred.successorSessionId);
    report.results.push({ provider, stage: "actual-handoff", accepted: true, predecessor: originalSession, successor: transferred.successor.sessionRef(), checkpoint: transferred.acceptanceCheckpointDigest }); save();
    await old.close();
    const active = transferred.successor;
    const draft = candidate(); draft.admissionDigest = admission.requirementsDigest;
    const review = assessment(draft), contract = assembleContract(draft, draft.requirements, review, "author");
    const store = db.qaPreparationStore();
    store.freezePolicy("run", resolveQaPreparationConfig({ mode: "enforce" }));
    const budget = store.ensureBudget("run", "T1", admission.requirementsDigest, 2, Date.now());
    store.putArtifact("semantic-assessment", review); store.retainProgress(budget, "inventory", draft.requirements); store.publish(contract, 0, Date.now());
    const longContext = "Synthetic transport padding, not additional requirements: " + "bounded fixture data αβγδ ".repeat(12000);
    await deliverVerificationContract(contract, store, active, cwd, cwd, longContext);
    assert.equal(assertContractReceipt(store, "run", "T1", admission.requirementsDigest, actualContractSession(active, cwd, cwd), active).contentDigest, contract.contentDigest);
    report.results.push({ provider, stage: "large-contract", bytes: Buffer.byteLength(longContext), accepted: true, receipt: store.receipts(contract.contentDigest) }); save();
    checkDeadline();
    const beforeCompaction = active.contractCompactionSequence?.() ?? 0;
    const compacted = await active.compact?.(); assert.equal(compacted?.ok, true, JSON.stringify(compacted));
    assert.ok((active.contractCompactionSequence?.() ?? 0) > beforeCompaction, "native compaction must be observed");
    assert.throws(() => assertContractReceipt(store, "run", "T1", admission.requirementsDigest, actualContractSession(active, cwd, cwd), active), /receipt|delivery/);
    await deliverVerificationContract(contract, store, active, cwd, cwd, "Synthetic contract renewal after native compaction; no implementation authorized.");
    assertContractReceipt(store, "run", "T1", admission.requirementsDigest, actualContractSession(active, cwd, cwd), active);
    const continuous = new ContinuityAdapter({ adapter: active, projectDir: cwd, runId: "run", role: "builder", settings: { role: "builder", source: "project", make: provider, model: "default", reasoning: "default", fast: false, session_strategy: "compact", settings_revision: 1, display_session_cost: false, auto_compact_threshold_percent: 65, compact_maximum: 10 } });
    const completed = await continuous.sendTurn("Synthetic transport verification complete. No tools or product changes. Submit completed work-report payload {disposition:'already-satisfied',evidence:['Transport fixture only'],coverage:null,graphMaintenance:null}. Include a valid bounded continuity object.", nativePolicy(workReportOutput, { responseOnly: true }));
    operationPayload(completed, workReportOutput);
    assert.equal(db.unresolvedRoleDispatches("run", "builder").length, 0);
    assert.equal(db.hasUncheckpointedRoleTurn("run", "builder"), false);
    report.results.push({ provider, stage: "compaction-renewal-and-continuity", accepted: true, dispatches }); save();
  } catch (error) { report.results.push({ provider, status: "failed", error: String(error), dispatches }); process.exitCode = 1; }
  finally { for (const adapter of adapters) await adapter.close().catch(() => {}); await Promise.all(pumps); db.close(); save(); }
}
report.finishedAt = new Date().toISOString(); save();
