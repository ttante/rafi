import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderSessionRefV1 } from "rafi-spec";
import { BuilderEventQueue } from "../src/activity.js";
import type { BuilderAdapter, TurnResult } from "../src/adapters/types.js";
import { runBranchPlan } from "../src/branch/runner.js";
import { Foreman } from "../src/foreman.js";
import { Log } from "../src/log.js";
import { qaDigest } from "../src/qaProtocolV2.js";
import type { QaSessionHandle } from "../src/qaReview.js";
import { cmdInit } from "../src/tickets/commands.js";
import { saveTickets } from "../src/tickets/ticketLoader.js";
import type { TicketDef } from "../src/tickets/ticketSchema.js";
import { WorkflowDb } from "../src/workflowDb.js";

const ticket: TicketDef = { id: "T001", order: 1000, title: "Guard", area: "core", priority: "P2", size: "S", risk: "Low", depends_on: [], summary: "Guard", acceptance: ["guard"], required_tests: ["static inspection"], likely_files: ["source.txt"] };
const qaReport = { version: 1, summary: "Needs a guard", checks_run: [{ check: "static", outcome: "failed", evidence: "missing" }], findings: [{ id: "QA-1", requirement: "guard", locations: ["source.txt"], problem: "missing guard", evidence: "source", expected: "guard", fix_direction: "add guard", verification: ["inspect"] }], observations: [] };

for (const caller of ["foreman", "branch"] as const) for (const mode of ["blocked", "tool-correction"] as const) test(`${caller} production delivery preserves ${mode} and never finalizes`, async () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-handback-caller-"));
  const adapters: BuilderAdapter[] = [];
  let remediationTurns = 0, reviewTurns = 0, observedRunId = "run", envelope = "";
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.com");
    writeFileSync(join(root, "source.txt"), "before\n");
    cmdInit(root, {}); saveTickets(join(root, ".tickets/tickets.yaml"), [ticket]); git("add", "."); git("commit", "-m", "fixture");
    const make = (cwd: string, role: "builder" | "qa"): BuilderAdapter => {
      const provider = caller === "foreman" ? "claude" : "codex";
      const queue = new BuilderEventQueue();
      const ref: ProviderSessionRefV1 = { version: 1, provider, sessionId: `${role}-session`, role, stream: role, generation: 0, cwd, configRoot: role === "builder" ? root : cwd, ticketId: "T001", source: "observed", createdAt: new Date(0).toISOString(), validatedAt: new Date(0).toISOString() };
      const adapter: BuilderAdapter = { agent: provider, sessionId: () => ref.sessionId, sessionRef: () => ref, observeEvents: listener => queue.observe(listener), events: () => queue, close: async () => { queue.close(); }, sendTurn: async prompt => {
        let text: string;
        if (role === "qa") { reviewTurns++; text = `RAFI_QA_FAILURE_REPORT_START\n${JSON.stringify(qaReport)}\nRAFI_QA_FAILURE_REPORT_END\nSTEP_STATUS: qa_fail | issues="missing guard"`; }
        else if (prompt.includes("QA failure handoff ID:")) {
          remediationTurns++;
          observedRunId = /Run ID: (.+)/.exec(prompt)?.[1] ?? observedRunId;
          if (mode === "blocked") text = 'STEP_STATUS: blocked | reason="Registry unavailable; restore approved registry access"';
          else {
            if (!envelope) envelope = `RAFI_BUILDER_QA_REMEDIATION_START\n${JSON.stringify({ version: 3, handoff_id: /QA failure handoff ID: ([a-f0-9]+)/.exec(prompt)![1], summary: "Reported", findings: [{ finding_key: /QA-1 -> ([a-f0-9]+)/.exec(prompt)![1], raw_id: "QA-1", disposition: "fixed", changes: ["guard"], evidence: "source", verification: [{ check: "inspect", outcome: "passed", evidence: "guard" }] }], observations: [] })}\nRAFI_BUILDER_QA_REMEDIATION_END\nSTEP_STATUS: done | summary="reported"`;
            text = remediationTurns === 1 ? `Prologue\n${envelope}` : envelope;
            if (remediationTurns === 2) queue.push({ kind: "tool", name: "Read", input: {}, providerTurnId: "turn-2" });
          }
        } else { writeFileSync(join(cwd, "source.txt"), "implementation\n"); text = 'STEP_STATUS: done | ticket="T001" summary="implemented"'; }
        const result: TurnResult = { text, rawResponse: text, cleanedResponse: text, hostInstruction: prompt, providerInstruction: prompt, isError: false, numTurns: 1, costUsd: 0, turnId: role === "qa" ? `qa-${reviewTurns}` : `turn-${remediationTurns}`, providerMetadata: { provider, sessionId: ref.sessionId, sessionRef: ref } };
        queue.push({ kind: "turn-complete", result, turnId: result.turnId }); return result;
      } };
      adapters.push(adapter); return adapter;
    };
    const createQa = async (cwd: string): Promise<QaSessionHandle> => {
      const adapter = make(cwd, "qa");
      const confinement = { version: 2 as const, sourceMode: "read-only" as const, scratchMode: "isolated" as const, settingsSources: "none" as const, networkMode: "disabled" as const, environmentDigest: "1".repeat(64), policyDigest: "2".repeat(64) };
      return { adapter, sessionIdentity: () => adapter.sessionRef!()!, effectiveRoleInstructions: "independent read-only QA", runtimeContext: {}, skills: [], confinement: { ...confinement, digest: qaDigest("qa-confinement", confinement) }, handoffReceipt: { kind: "initial" } };
    };
    const log = new Log(join(root, ".foreman/test.jsonl"));
    if (caller === "foreman") {
      const foreman = new Foreman(make(root, "builder"), log, false, true, 1, root, undefined, createQa, "compact", undefined, "compact", undefined, undefined, async adapter => adapter);
      const result = await foreman.runBatch(1); assert.equal(result.outcome, "blocked", result.detail);
    } else {
      const result = await runBranchPlan({ projectDir: root, runId: "run", plan: { baseRef: "main", nodes: [{ ticket, branch: "ticket/t001", baseRef: "main", baseBranch: "main", dependencies: [], depth: 1 }], issues: [] }, log, notificationsEnabled: false, qaEnabled: true, qaMaxFixAttempts: 1, createPr: false, prReady: false, keepWorktrees: true, baseWorktreePolicy: "skip", createBuilder: async cwd => make(cwd, "builder"), builderSessionBoundary: async adapter => adapter, createQa });
      assert.equal(result[0]?.buildStatus, "blocked", result[0]?.detail);
      assert.ok(reviewTurns, result[0]?.detail);
    }
    assert.equal(reviewTurns, 1, "blockers and unsafe corrections do not cause repeated full reviews");
    assert.equal(remediationTurns, mode === "blocked" ? 1 : 2);
    const db = new WorkflowDb(root);
    try {
      const handoff = db.qaFailureHandoffs(observedRunId, "T001")[0]!; assert.ok(handoff);
      assert.equal(db.qaDeliveryTurns(handoff.operationId).length, remediationTurns);
      assert.equal(db.qaTicketHead(observedRunId, "T001").passCertificateId, undefined);
      assert.equal(db.qaRemediationStop(observedRunId, "T001")?.outcome, mode === "blocked" ? "blocked" : "response-invalid");
    } finally { db.close(); }
  } finally { for (const adapter of adapters) await adapter.close(); rmSync(root, { recursive: true, force: true }); }
});
