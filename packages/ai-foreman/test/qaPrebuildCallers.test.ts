import test from "node:test";
import { DEFAULT_GRAPH_CONFIG } from "rafi-spec";
import { adoptGraph } from "../src/graph/maintenance.js";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { WorkflowDb } from "../src/workflowDb.js";
import { Foreman } from "../src/foreman.js";
import { ensureBuilderContract } from "../src/qaBuildGate.js";
import { ProviderPhaseBarrier } from "../src/providerPhase.js";
import { loadRoleBundle } from "../src/roles.js";
import { Log } from "../src/log.js";
import { runBranchPlan } from "../src/branch/runner.js";
import { cmdInit } from "../src/tickets/commands.js";
import { saveTickets } from "../src/tickets/ticketLoader.js";
import { createProviderSessionRef } from "../src/sessionIdentity.js";
import { resolveQaPreparationConfig, depthObligations } from "../src/qaPreparationPolicy.js";
import { decision, digest } from "./qaPreparationFixtures.js";
import type { QaContractCandidateV1 } from "rafi-spec";
import type { BuilderAdapter } from "../src/adapters/types.js";
import type { QaSessionHandle } from "../src/qaReview.js";
import type { TicketDef } from "../src/tickets/ticketSchema.js";

for (const graphEnabled of [false, true]) for (const [branch, provenanceOnly, level] of [[false, false, 2], [false, true, 2], [true, false, 2], [true, false, 1], [true, false, 3], [true, false, 4], [true, false, 5]] as const) test(`actual ${branch ? "branch runner" : "Foreman"} uses shared preparation, delivery and evidence gates even with independent final QA disabled (provenance-only=${provenanceOnly}, graph=${graphEnabled}, depth=${level})`, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "qa-real-caller-"))), phases: string[] = [];
  const ticket: TicketDef = { id: "T001", order: 1, title: "Token guard", area: "core", priority: "P2", size: "S", risk: "Low", depends_on: [], summary: "Reject expired token", acceptance: ["Reject expired token"], required_tests: [], likely_files: ["product.txt"], notes: "Preserve expiry boundary", rollback: "Revert guard", qa_preparation: decision(level) };
  const envelope = (tag: string, value: unknown) => `${tag}_START\n${JSON.stringify(value)}\n${tag}_END`;
  let qaSessions = 0, currentContract: import("rafi-spec").QaVerificationContractV1 | undefined;
  const createQa = async (cwd: string): Promise<QaSessionHandle> => {
    const sessionId = `preparation-${++qaSessions}`;
    let original: string | undefined;
    const adapter: BuilderAdapter = { agent: "claude", sessionId: () => sessionId, events: async function* () {}, close: async () => {}, sendTurn: async (instruction, policy) => {
      if (graphEnabled && !original) {
        original = instruction;
        assert.match(instruction, /rafi_graph_evidence/);
        assert.equal(policy?.purpose, "preparation");
        return { text: JSON.stringify({ kind: "rafi_graph_request", version: 1, requestId: sessionId, operations: [{ operation: "query", query: "expiry boundary" }] }), isError: false, numTurns: 1, costUsd: 0 };
      }
      if (graphEnabled) {
        assert.match(instruction, /Continue the same frozen action/);
        assert.equal(policy?.purpose, "preparation");
        instruction = original!;
      }
      assert.ok(instruction.includes("Frozen admitted work definition:")); assert.ok(instruction.includes("Preserve expiry boundary")); assert.ok(instruction.includes("Revert guard"));
      if (instruction.includes("QA preparation only.")) {
        phases.push("prepare");
        const draft = JSON.parse(instruction.split("Authoritative candidate/input inventory:\n")[1]!.split("\nOriginal approved plan context:")[0]!) as QaContractCandidateV1;
        draft.checks = [{ id: "expiry", requirementRefs: draft.requirements.map(req => req.id), origin: "explicit", expectedBehavior: "Reject expired token while preserving applicable project invariants", obligation: "mandatory", timing: "postimplementation", applicability: { kind: "unconditional", decisionOwner: "qa", requiredEvidence: [] }, verification: [{ kind: "procedure", steps: ["Independently inspect expiry rejection and applicable project invariants"], cwd: ".", fixtures: [], runtime: "node20", timeoutMs: 30000, expectedOutcome: "Expiry rejection and mapped invariants hold" }], expectedEvidence: ["Independent inspection"], prerequisiteRefs: [], dependsOnChecks: [] }];
        draft.coverage = draft.requirements.map(req => ({ requirementId: req.id, checkIds: ["expiry"] }));
        draft.preparationEvidence = depthObligations(level).map(obligation => ({ obligation, references: [{ path: "product.txt", digest, locator: "expiry behavior" }], analysis: `Inspected ${obligation} against the token guard and each authoritative requirement`, operationId: "host-bound", sessionId, evidenceDigest: digest, graphReceiptRefs: ["agent-invented-receipt"] }));
        return { text: envelope("RAFI_QA_CANDIDATE", draft), isError: false, numTurns: 1, costUsd: 0 };
      }
      if (instruction.includes("Independent approach challenge")) {
        phases.push("challenge");
        const draft = JSON.parse(instruction.split("\nOriginal approved plan context:")[0]!.split("\n").at(-1)!) as QaContractCandidateV1;
        const binding = JSON.parse(instruction.split("Binding: ")[1]!.split(". Previously retained concerns")[0]!);
        return { text: envelope("RAFI_QA_CHALLENGE", { version: 1, ...binding, sessionId, operationId: "host-bound", assessedRequirementIds: draft.requirements.map(req => req.id), assessedObligations: depthObligations(level), concerns: [], approach: "Critiqued the retained source-based approach", concernCategories: ["scope", "invariants", "failure-boundaries", "verification"], approachConcerns: [] }), isError: false, numTurns: 1, costUsd: 0 };
      }
      phases.push("assess"); const draft = JSON.parse(instruction.split("\nDraft:\n")[1]!.split("\nOriginal approved plan context:")[0]!) as QaContractCandidateV1;
      const binding = JSON.parse(instruction.split("Bind exactly ")[1]!.split(".\n")[0]!);
      return { text: envelope("RAFI_QA_ASSESSMENT", { version: 1, ...binding, sessionId, operationId: "host-bound", assessedRequirementIds: draft.requirements.map(req => req.id), assessedObligations: depthObligations(level), concerns: [] }), isError: false, numTurns: 1, costUsd: 0 };
    } };
    return { adapter } as QaSessionHandle;
  };
  const createBuilder = async (cwd: string): Promise<BuilderAdapter> => {
    const ref = createProviderSessionRef({ provider: "claude", sessionId: `builder:${cwd}`, role: "builder", stream: "builder", generation: 0, cwd, configRoot: root, source: "observed", validatedAt: new Date().toISOString() });
    return { agent: "claude", sessionId: () => ref.sessionId, sessionRef: () => ref, events: async function* () {}, close: async () => {}, contractCapabilities: () => ({ sameSessionAcceptance: true, nativeCompactionBarrier: true }), enableContractEnforcement: () => {}, contractCompactionSequence: () => 0, acceptContractDelivery: () => {}, sendTurn: async (instruction, policy) => {
      if (policy?.purpose === "contract-acceptance") { phases.push("accept"); currentContract = JSON.parse(instruction.split("Full structured contract:\n")[1]!.split("\n")[0]!); return { text: envelope("RAFI_QA_ACCEPTANCE", { workId: ticket.id, revision: currentContract!.revision, digest: currentContract!.contentDigest, missingSections: [] }), isError: false, numTurns: 1, costUsd: 0 }; }
      if (policy?.responseOnly) { phases.push("claims"); const binding = JSON.parse(instruction.split("Exact coverage binding: ")[1]!.split("\n")[0]!); return { text: envelope("RAFI_QA_COVERAGE", { ...binding, checks: currentContract!.checks.map(check => ({ checkId: check.id, applicability: "applicable", predicateEvidence: [], outcome: "not-run", evidence: [] })) }), isError: false, numTurns: 1, costUsd: 0 }; }
      phases.push("implement"); assert.ok(instruction.includes("Preserve expiry boundary")); assert.ok(instruction.includes("Revert guard")); assert.ok(instruction.includes(currentContract!.contentDigest)); writeFileSync(join(cwd, "product.txt"), "implemented expiry rejection\n");
      return { text: `STEP_STATUS: done | ticket="${ticket.id}" summary="Guard implemented; final verification remains unverified"`, turnId: "implementation", isError: false, numTurns: 1, costUsd: 0 };
    } };
  };
  try {
    execFileSync("git", ["init", "-q", root]); cmdInit(root, {}); saveTickets(join(root, ".tickets/tickets.yaml"), [ticket]); writeFileSync(join(root, "product.txt"), "baseline\n"); execFileSync("git", ["add", "."], { cwd: root }); execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"], { cwd: root });
    if (graphEnabled) adoptGraph(root, { authorization: "explicit", config: { ...structuredClone(DEFAULT_GRAPH_CONFIG), mode: "code-only", include: ["product.txt"] } });
    const db = new WorkflowDb(root); db.ensureRun("run"); db.qaPreparationStore().freezePolicy("run", resolveQaPreparationConfig({ mode: "enforce" })); db.admitWork({ runId: "run", kind: "ticket", ticketId: ticket.id, definition: ticket, approvalId: "fixture", scopeRevision: "fixture", provenance: { userTurn: "Build approved token guard", reason: "Explicit execution fixture" } }); db.close();
    if (branch) {
      const base = execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim();
      const result = await runBranchPlan({ projectDir: root, runId: "run", plan: { baseRef: base, nodes: [{ ticket, branch: "ticket/T001", baseRef: base, baseBranch: base, dependencies: [], depth: 0 }], issues: [] }, log: new Log(join(root, ".foreman", "branch-test.jsonl")), notificationsEnabled: false, qaEnabled: false, createPr: false, prReady: false, keepWorktrees: true, baseWorktreePolicy: "skip", createBuilder, createQa });
      assert.equal(result[0]?.buildStatus, "done", JSON.stringify(result));
    } else {
      const args: ConstructorParameters<typeof Foreman> = [await createBuilder(root), new Log(join(root, ".foreman", "caller-test.jsonl")), false, false, 1, root, undefined, createQa]; args[22] = "run"; args[24] = ticket.id;
      const result = await new Foreman(...args).runInstruction("Implement the approved token guard"); assert.equal(result.status.kind, "done", result.result.text);
    }
    assert.deepEqual(phases, ["prepare", "assess", ...(level === 5 ? ["challenge"] : []), "accept", "implement", "claims"]);
    assert.equal(currentContract!.depthDecision.level, level);
    for (const evidence of currentContract!.preparationEvidence) assert.equal(evidence.graphReceiptRefs?.length ?? 0, graphEnabled ? 2 : 0);
    if (!branch) {
      const original = currentContract!;
      // A new host adapter can resume the exact native identity while its
      // in-memory compaction barrier is still fresh and unarmed.
      const resumedBuilder = await createBuilder(root), barrier = new ProviderPhaseBarrier();
      resumedBuilder.enableContractEnforcement = () => barrier.enableEnforcement();
      resumedBuilder.acceptContractDelivery = sequence => barrier.accept(sequence);
      resumedBuilder.contractCompactionSequence = () => barrier.compactionSequence;
      await ensureBuilderContract(root, "run", ticket.id, root, resumedBuilder, createQa);
      assert.equal(phases.at(-1), "accept"); assert.equal(currentContract!.contentDigest, original.contentDigest);
      const acceptedTurns = phases.length;
      await ensureBuilderContract(root, "run", ticket.id, root, resumedBuilder, createQa);
      assert.equal(phases.length, acceptedTurns, "A live accepted adapter can reuse its receipt");
      barrier.compact(); assert.match(barrier.denial("Write")!, /renewal required/);
      await ensureBuilderContract(root, "run", ticket.id, root, resumedBuilder, createQa);
      assert.equal(phases.length, acceptedTurns + 1); assert.equal(barrier.denial("Write"), undefined);
      assert.match(barrier.denial("Agent")!, /cannot delegate/);
      const role = loadRoleBundle("builder", { projectDir: root });
      const compiled = join(root, ".rafi", "compiled", "builder"); mkdirSync(compiled, { recursive: true });
      writeFileSync(join(compiled, "system.md"), provenanceOnly ? role.system : "Retain the original expiry boundary and explicitly inspect the approved failure path.");
      writeFileSync(join(compiled, "meta.json"), JSON.stringify({ skills: provenanceOnly ? role.skills : [] }));
      const args: ConstructorParameters<typeof Foreman> = [await createBuilder(root), new Log(join(root, ".foreman", "amendment-test.jsonl")), false, false, 1, root, undefined, createQa]; args[22] = "run"; args[24] = ticket.id;
      const resumed = await new Foreman(...args).runInstruction("Continue the same approved token guard under clarified project rules");
      assert.equal(resumed.status.kind, "done", resumed.result.text);
      assert.equal(currentContract!.revision, 2); assert.equal(currentContract!.predecessorDigest, original.contentDigest);
      assert.notEqual(currentContract!.contentDigest, original.contentDigest);
      if (provenanceOnly) { assert.deepEqual(currentContract!.requirements, original.requirements); assert.notDeepEqual(currentContract!.inputs, original.inputs); }
      assert.deepEqual(phases, ["prepare", "assess", "accept", "implement", "claims", "accept", "accept", "prepare", "assess", "accept", "implement", "claims"]);
    }
    const inspected = new WorkflowDb(root); try { const admission = inspected.assertAdmittedWork("run", ticket.id), store = inspected.qaPreparationStore(); assert.equal(store.head("run", ticket.id, admission.requirementsDigest).state, "ready"); assert.equal(store.receipts(currentContract!.contentDigest).length, 1); assert.equal(inspected.qaReviewAttempts("run", ticket.id).length, 0); } finally { inspected.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an older run without preparation policy remains explicitly legacy when global configuration enables enforcement", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "qa-legacy-resume-")));
  try {
    const db = new WorkflowDb(root); db.ensureRun("older-run"); db.close();
    writeFileSync(join(root, "rafi-config.yaml"), "qa_preparation:\n  mode: enforce\n");
    const adapter: BuilderAdapter = { agent: "codex", sessionId: () => undefined, events: async function* () {}, close: async () => {}, sendTurn: async () => { throw new Error("Legacy resume cannot dispatch preparation or acceptance"); } };
    assert.equal(await ensureBuilderContract(root, "older-run", "T1", root, adapter), "");
    const inspected = new WorkflowDb(root);
    try { assert.equal(inspected.qaPreparationStore().policy("older-run")!.mode, "legacy"); }
    finally { inspected.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const mode of ["legacy", "shadow"] as const) test(`actual Foreman ${mode} mode preserves authorized implementation without inventing an enforcing receipt`, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `qa-${mode}-caller-`))); let builderTurns = 0, preparationTurns = 0;
  const ticket: TicketDef = { id: "T001", order: 1, title: "Token guard", area: "core", priority: "P2", size: "S", risk: "Low", depends_on: [], summary: "Reject expired token", acceptance: ["Reject expired token"], required_tests: ["Inspect token regression"], likely_files: ["product.txt"], qa_preparation: decision(2) };
  try {
    execFileSync("git", ["init", "-q", root]); cmdInit(root, {}); saveTickets(join(root, ".tickets/tickets.yaml"), [ticket]); writeFileSync(join(root, "product.txt"), "baseline\n");
    execFileSync("git", ["add", "."], { cwd: root }); execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], { cwd: root });
    const db = new WorkflowDb(root); db.ensureRun("run"); db.qaPreparationStore().freezePolicy("run", resolveQaPreparationConfig({ mode })); db.admitWork({ runId: "run", kind: "ticket", ticketId: ticket.id, definition: ticket, approvalId: "fixture", scopeRevision: "fixture", provenance: { userTurn: "Implement token guard", reason: "Explicit execution fixture" } }); db.close();
    const adapter: BuilderAdapter = { agent: "codex", sessionId: () => "legacy-capability-builder", events: async function* () {}, close: async () => {}, sendTurn: async () => { builderTurns++; return { text: `STEP_STATUS: done | ticket="${ticket.id}"`, isError: false, numTurns: 1, costUsd: 0 }; } };
    const createQa = async (): Promise<QaSessionHandle> => ({ adapter: { agent: "codex", sessionId: () => "confined-preparation", events: async function* () {}, close: async () => {}, sendTurn: async () => { preparationTurns++; return { text: "Controlled preparation failure", isError: true, numTurns: 0, costUsd: 0 }; } } } as unknown as QaSessionHandle);
    const args: ConstructorParameters<typeof Foreman> = [adapter, new Log(join(root, ".foreman", "mode-test.jsonl")), false, false, 1, root, undefined, createQa]; args[22] = "run"; args[24] = ticket.id;
    const result = await new Foreman(...args).runInstruction("Implement approved token guard"); assert.equal(result.status.kind, "done", result.result.text);
    assert.equal(builderTurns, 1); assert.equal(preparationTurns, mode === "shadow" ? 1 : 0);
    const inspected = new WorkflowDb(root);
    try { const store = inspected.qaPreparationStore(), admission = inspected.assertAdmittedWork("run", ticket.id); assert.equal(store.head("run", ticket.id, admission.requirementsDigest).digest, undefined); assert.equal(store.metrics("run").firstReviewPasses, 0); assert.equal(store.metrics("run").preparationFailures, mode === "shadow" ? 1 : 0); }
    finally { inspected.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
