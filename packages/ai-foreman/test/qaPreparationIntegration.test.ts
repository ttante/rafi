import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Foreman } from "../src/foreman.js";
import { Log } from "../src/log.js";
import { cmdInit } from "../src/tickets/commands.js";
import { saveTickets } from "../src/tickets/ticketLoader.js";
import { WorkflowDb } from "../src/workflowDb.js";
import { candidate, assessment, coverage, digest } from "./qaPreparationFixtures.js";
import { assembleContract, contractDigest } from "../src/qaVerificationContract.js";
import { resolveQaPreparationConfig } from "../src/qaPreparationPolicy.js";
import { resolveEffectiveQaConfiguration } from "../src/qaEffectiveConfig.js";
import { deliverVerificationContract } from "../src/qaContractDelivery.js";
import { beginBuildAssignment, finishBuildAssignment, captureBuildSource } from "../src/buildAssignment.js";
import { collectBuilderContractCoverage } from "../src/qaBuilderCoverage.js";
import { qaDigest, type QaReviewBasisV2 } from "../src/qaProtocolV2.js";
import { qaReportDigest } from "../src/qaRecovery.js";
import { createProviderSessionRef } from "../src/sessionIdentity.js";
import type { BuilderAdapter } from "../src/adapters/types.js";

function fixture(kind: "ticket" | "synthetic" = "ticket", branch = false, compiled = false, tracker = false, publish = true, baseline = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "qa-workflow-contract-"))), workspace = branch ? join(root, "branch") : root;
  mkdirSync(workspace, { recursive: true }); writeFileSync(join(workspace, "product.txt"), "baseline");
  if (compiled) {
    for (const role of ["qa", "builder"]) { const directory = join(root, ".rafi", "compiled", role); mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, "system.md"), `Canonical ${role} sentinel: independently verify expiry`); writeFileSync(join(directory, "meta.json"), JSON.stringify({ skills: [] })); }
    writeFileSync(join(root, ".gitignore"), ".rafi/\n.foreman/\n");
  }
  const ticket = { id: "T1", order: 1, title: "Token expiry", area: "core", priority: "P2", size: "S", risk: "Low", summary: "Reject expired token", acceptance: ["Reject expired token"], required_tests: [], depends_on: [], rollback: "Revert token guard", notes: "Preserve exact boundary", likely_files: ["product.txt"] } as import("../src/tickets/ticketSchema.js").TicketDef;
  if (tracker) { cmdInit(root, {}); saveTickets(join(root, ".tickets/tickets.yaml"), [ticket]); }
  const db = new WorkflowDb(root); db.ensureRun("run"); db.qaPreparationStore().freezePolicy("run", resolveQaPreparationConfig({ mode: "enforce" }));
  const workId = kind === "synthetic" ? `synthetic:${randomUUID()}` : "T1";
  const admission = db.admitWork({ runId: "run", workId, kind, ...(kind === "ticket" ? { ticketId: workId } : {}), definition: { ...ticket, id: workId }, approvalId: "approved", scopeRevision: "r1", provenance: { userTurn: "Implement the approved behavior", reason: "Explicit test authorization" } });
  const store = db.qaPreparationStore(), draft = candidate(); draft.workId = workId; draft.admissionDigest = admission.requirementsDigest;
  const effective = resolveEffectiveQaConfiguration(root, { make: "claude" });
  draft.inputs.push({ id: "rules", kind: "rules", reference: root, digest: effective.digest, authority: "project-rule", revision: "current", availability: "available" }, { id: "checklist", kind: "checklist", reference: "canonical", digest: contractDigest("input-checklist", effective.checklist), authority: "project-rule", revision: "current", availability: "available" });
  if (baseline) {
    draft.checks[0]!.timing = "preimplementation";
    const evidenceDigest = store.putArtifact("baseline-observation", { procedure: "Verify baseline readiness", result: "ready" });
    draft.baseline = [{ id: "baseline-ready", checkId: "check", applicability: "applicable", sourceDigest: digest, phase: "preimplementation-investigation", runtime: "node20", procedure: "Verify baseline readiness", observedAt: new Date().toISOString(), status: "passed", evidenceDigest, relevance: "prerequisite", expectedTransition: "Remains ready" }];
  }
  const review = assessment(draft), contract = assembleContract(draft, draft.requirements, review, "author");
  const budget = store.ensureBudget("run", workId, admission.requirementsDigest, 2, Date.now()); store.putArtifact("semantic-assessment", review); store.retainProgress(budget, "inventory", draft.requirements); if (publish) store.publish(contract, 0, Date.now());
  let sequence = 0, turns = 0, failCoverage = false;
  const adapter: BuilderAdapter = { agent: "claude", sessionId: () => "actual-builder", sessionRef: () => createProviderSessionRef({ provider: "claude", sessionId: "actual-builder", role: "builder", stream: "builder", generation: 1, cwd: workspace, configRoot: root, source: "observed" }), events: async function* () {}, close: async () => {},
    contractCapabilities: () => ({ sameSessionAcceptance: true, nativeCompactionBarrier: true }), contractCompactionSequence: () => sequence, enableContractEnforcement: () => {}, acceptContractDelivery: () => {},
    sendTurn: async (instruction, policy) => {
      turns++; assert.equal(policy?.responseOnly, true);
      let value: unknown, tag: string;
      if (policy?.purpose === "contract-acceptance") { tag = "RAFI_QA_ACCEPTANCE"; value = { workId, revision: contract.revision, digest: contract.contentDigest, missingSections: [] }; }
      else { tag = "RAFI_QA_COVERAGE"; const binding = JSON.parse(instruction.split("Exact coverage binding: ")[1]!.split("\n")[0]!); value = { ...coverage(contract), ...binding, checks: [{ ...coverage(contract).checks[0]!, outcome: failCoverage ? "not-run" : "passed", evidence: [{ procedure: "Inspect regression result", cwd: workspace, runtime: "node20", sourceDigest: binding.sourceDigest, reference: "retained-output" }] }] }; }
      return { text: `${tag}_START\n${JSON.stringify(value)}\n${tag}_END`, isError: false, costUsd: 0, numTurns: 1 };
    } };
  return { root, workspace, db, store, contract, admission, adapter, workId, ticket, compact: () => { sequence++; }, turns: () => turns, blockedClaims: () => { failCoverage = true; }, cleanup: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

for (const [kind, branch] of [["ticket", false], ["ticket", true], ["synthetic", false]] as const) test(`shared contract gate, actual delivery and completion coverage: ${kind}, branch=${branch}`, async () => {
  const f = fixture(kind, branch);
  try {
    assert.throws(() => beginBuildAssignment(f.root, "run", f.workId, f.workspace, "Implement", undefined, f.adapter), /receipt/);
    await deliverVerificationContract(f.contract, f.store, f.adapter, f.workspace, f.root, "Complete authorized context");
    assert.throws(() => beginBuildAssignment(f.root, "run", f.workId, f.workspace, "Implement", undefined, { ...f.adapter }), /current adapter/);
    f.compact(); assert.throws(() => beginBuildAssignment(f.root, "run", f.workId, f.workspace, "Implement", undefined, f.adapter), /receipt/);
    await deliverVerificationContract(f.contract, f.store, f.adapter, f.workspace, f.root, "Complete authorized context");
    assert.throws(() => f.db.planOperation({ runId: "run", idempotencyKey: "older-caller-without-binding", kind: "build-assignment", intent: { ticketId: f.workId, requirementsDigest: f.admission.requirementsDigest } }), /tagged actual-session contract delivery/);
    const assignment = beginBuildAssignment(f.root, "run", f.workId, f.workspace, "Implement", undefined, f.adapter);
    writeFileSync(join(f.workspace, "product.txt"), "implemented");
    const response = { text: `STEP_STATUS: done | ticket="${f.workId}"`, isError: false, numTurns: 1, costUsd: 0, turnId: "implementation-turn" };
    await collectBuilderContractCoverage(f.root, "run", f.workId, f.workspace, f.adapter, assignment.operationId, assignment.instruction, response);
    assert.equal(finishBuildAssignment(f.root, assignment, response, { kind: "done", ticket: f.workId }), undefined);
    const before = f.turns(); await collectBuilderContractCoverage(f.root, "run", f.workId, f.workspace, f.adapter, assignment.operationId, assignment.instruction, response); assert.equal(f.turns(), before);
    assert.equal(f.store.metrics("run").started, 1);
  } finally { f.cleanup(); }
});

test("completed Builder marker without durable coverage is rejected and its source/response are retained", async () => {
  const f = fixture();
  try {
    await deliverVerificationContract(f.contract, f.store, f.adapter, f.workspace, f.root, "Context");
    const assignment = beginBuildAssignment(f.root, "run", f.workId, f.workspace, "Implement", undefined, f.adapter);
    const rejection = finishBuildAssignment(f.root, assignment, { text: 'STEP_STATUS: done | ticket="T1"', isError: false, costUsd: 0, numTurns: 1 }, { kind: "done", ticket: "T1" });
    assert.match(rejection!, /coverage/); assert.equal(f.db.operation(assignment.operationId)?.status, "confirmed");
  } finally { f.cleanup(); }
});

test("certificate issue and consumption bind immutable dispatch, terminal coverage and current contract", () => {
  const f = fixture();
  try {
    const sourceDigest = captureBuildSource(f.workspace).digest, attemptId = "fresh-review", sessionId = "fresh-independent-reviewer", instruction = "Independently verify this source";
    const fields = { version: 2 as const, contractBinding: { version: 1 as const, transportVersion: 1 as const, revision: 1, digest: f.contract.contentDigest, admissionDigest: f.admission.requirementsDigest, commonConfigDigest: f.contract.inputs.find(row => row.kind === "rules")!.digest }, ticketDigest: qaDigest("ticket", f.ticket), instructionDigest: qaDigest("instruction", instruction), roleInstructionsDigest: digest, skillsDigest: digest, runtimeDigest: digest, validationChecklistDigest: digest, confinementDigest: digest };
    const basis: QaReviewBasisV2 = { ...fields, digest: qaDigest("review-basis-fields", fields) }; f.db.putQaReviewBasis("run", f.workId, basis);
    let head = f.db.qaTicketHead("run", f.workId); head = f.db.transitionQa("run", f.workId, head.revision, { type: "source-frozen", sourceStateDigest: sourceDigest }); head = f.db.transitionQa("run", f.workId, head.revision, { type: "review-ready", reviewBasisDigest: basis.digest, sessionGeneration: 1 });
    f.db.beginQaReviewAttempt({ attemptId, runId: "run", ticketId: f.workId, reviewNumber: head.reviewNumber, cycle: 1, remediationGeneration: 0, sourceDigest });
    const at = new Date().toISOString(), operationId = "independent-turn";
    f.db.commitQaTurnIntent({ version: 2, operationId, runId: "run", ticketId: f.workId, reviewNumber: head.reviewNumber, sessionGeneration: 1, slot: "initial", sourceStateDigest: sourceDigest, reviewBasisDigest: basis.digest, instructionDigest: f.db.putEvidence("qa", `${instruction}\nImmutable input-basis digest: ${basis.digest}. Coverage must bind this inputBasisDigest.`), intendedAt: at, providerSession: { version: 2, provider: "claude", sessionId, role: "qa", stream: "qa", generation: 1, cwd: f.workspace, configRoot: f.root, createdAt: at, validatedAt: at } }, head.revision);
    head = f.db.qaTicketHead("run", f.workId);
    const result = { ...coverage(f.contract), workId: f.workId, sourceDigest, inputBasisDigest: basis.digest, attemptId, sessionId }; result.checks[0]!.evidence[0]!.sourceDigest = sourceDigest;
    const response = `RAFI_QA_COVERAGE_START\n${JSON.stringify(result)}\nRAFI_QA_COVERAGE_END\nSTEP_STATUS: qa_pass`;
    const responseDigest = f.db.putEvidence("qa", response), receipt = { version: 2 as const, operationId, dispatch: "completed" as const, providerTurnId: "native-turn", terminalEventObserved: true, sourceStateDigest: sourceDigest, reviewBasisDigest: basis.digest, rawResponseDigest: responseDigest, cleanedResponseDigest: responseDigest, completedAt: at }; f.db.finishQaTurn(receipt);
    const input = { runId: "run", ticketId: f.workId, qaRevision: head.revision + 1, sourceStateDigest: sourceDigest, reviewBasisDigest: basis.digest, turnReceiptDigest: qaDigest("turn-receipt", receipt) };
    assert.throws(() => f.db.commitQaPassAttempt(attemptId, input, "Generic pass", head.revision), /tagged contract coverage/); assert.equal(f.db.qaReviewAttempt(attemptId)?.status, "started");
    const binding = { version: 1 as const, revision: 1, contractDigest: f.contract.contentDigest, coverageDigest: f.store.putArtifact("final-coverage", result), attemptId, sessionId };
    const certificate = f.db.commitQaPassAttempt(attemptId, { ...input, contractCoverage: binding }, "Verified all checks", head.revision);
    f.store.setState("run", f.workId, f.admission.requirementsDigest, "amendment-required", "Rules changed", f.store.head("run", f.workId, f.admission.requirementsDigest).generation);
    assert.throws(() => f.db.consumeQaPassCertificate("run", f.workId, certificate.certificateId, "finalization"), /stale or incomplete/);
  } finally { f.cleanup(); }
});

for (const scenario of ["isolated", "qa-only", "isolated-baseline", "qa-only-baseline", "stale-qa-only", "missing-qa-only", "changed-scope-qa-only"] as const) test(`canonical contract-bound final review/recovery: ${scenario}`, async () => {
  const qaOnly = !scenario.startsWith("isolated"), blocked = scenario.startsWith("stale") || scenario.startsWith("missing") || scenario.startsWith("changed");
  const { execFileSync } = await import("node:child_process");
  const { AsyncQueue } = await import("../src/util/asyncQueue.js");
  const { runIsolatedQa } = await import("../src/qaReview.js");
  const { describeQaRuntimeHandle } = await import("../src/qaRuntime.js");
  const { finalQaRoleInstructions } = await import("../src/qaEffectiveConfig.js");
  const f = fixture("ticket", false, true, qaOnly, scenario !== "missing-qa-only", scenario.endsWith("baseline")); let reviews = 0;
  try {
    execFileSync("git", ["init", "-q", f.root]); execFileSync("git", ["add", "."], { cwd: f.root }); execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], { cwd: f.root });
    if (scenario === "isolated-baseline") {
      const sourceDigest = captureBuildSource(f.workspace).digest;
      const claim = { ...coverage(f.contract), phase: "builder", sourceDigest };
      const coverageDigest = f.store.putArtifact("builder-coverage", claim);
      for (const [id, boundSource] of [["current-claims", sourceDigest], ["stale-claims", digest]]) {
        f.db.planOperation({ runId: "run", idempotencyKey: id!, kind: "builder-coverage", intent: { workId: f.workId, contractDigest: f.contract.contentDigest } });
        f.db.updateOperation(id!, "in_progress");
        f.db.updateOperation(id!, "confirmed", { result: { coverageDigest, binding: { sourceDigest: boundSource } } });
      }
    }
    if (scenario === "stale-qa-only") f.store.setState("run", f.workId, f.admission.requirementsDigest, "amendment-required", "Authorized rules changed", f.store.head("run", f.workId, f.admission.requirementsDigest).generation);
    if (scenario === "changed-scope-qa-only") { f.ticket.acceptance = ["An unapproved new product preference"]; saveTickets(join(f.root, ".tickets/tickets.yaml"), [f.ticket]); }
    const execute = async (options: Parameters<typeof runIsolatedQa>[0]) => {
      if (!qaOnly) return runIsolatedQa(options);
      const args: ConstructorParameters<typeof Foreman> = [f.adapter, new Log(join(f.root, ".foreman", "qa-only-test.jsonl")), false, true, 1, f.root, undefined, options.createQa, "fresh"];
      args[22] = "run"; args[24] = f.workId;
      const before = f.turns();
      try { return await new Foreman(...args).runPendingQaRecovery(f.workId, "Recover original QA authority without Builder work"); }
      finally { assert.equal(f.turns(), before, "QA-only recovery cannot run Builder preflight, proposal, acceptance, preparation or implementation"); }
    };
    const pending = execute({ ticket: f.ticket, builderWorktree: f.workspace, builderSummary: "Implemented token expiry", qaStrategy: "fresh", state: { reviews: 0, modificationViolations: 0 }, recovery: { projectDir: f.root, runId: "run" }, maxCycles: 1,
      sessionBoundary: async () => { throw new Error("Fresh initial review needs no replacement"); },
      createQa: async cwd => {
        const events = new AsyncQueue<import("../src/adapters/types.js").BuilderEvent>(), ref = createProviderSessionRef({ provider: "claude", sessionId: "actual-fresh-review", role: "qa", stream: "qa", generation: 0, cwd, configRoot: f.root, source: "observed", validatedAt: new Date().toISOString() });
        const adapter: BuilderAdapter = { agent: "claude", sessionId: () => ref.sessionId, sessionRef: () => ref, events: () => events, close: async () => events.close(), sendTurn: async instruction => {
          reviews++; assert.ok(instruction.includes("Expired tokens return unauthorized"));
          // Generate claims solely from what the actual QA provider receives;
          // host fixture access used to mask the missing baseline context.
          const context = JSON.parse(instruction.split("Full structured review context:\n")[1]!.split("\n")[0]!) as { contract: typeof f.contract; baselineEvidence: Array<{ digest: string; artifact: { procedure: string; result: string } }>; builderClaims: Array<{ operationId: string }> };
          const resource = instruction.match(/Complete retained QA context: (.*)\n/)![1]!;
          assert.deepEqual(JSON.parse(readFileSync(resource, "utf8")), context);
          assert.ok(resource.startsWith(realpathSync(cwd) + "/"));
          if (scenario.endsWith("baseline")) { assert.equal(context.baselineEvidence[0]!.digest, context.contract.baseline[0]!.evidenceDigest); assert.equal(context.baselineEvidence[0]!.artifact.procedure, "Verify baseline readiness"); assert.equal(context.baselineEvidence[0]!.artifact.result, "ready"); }
          assert.deepEqual(context.builderClaims.map(claim => claim.operationId), scenario === "isolated-baseline" ? ["current-claims"] : []);
          const binding = JSON.parse(instruction.split("Coverage binding: ")[1]!.split("\n")[0]!); const basis = instruction.match(/Immutable input-basis digest: ([a-f0-9]{64})/)![1]!;
          const claim = { ...coverage(context.contract), ...binding, version: 1, inputBasisDigest: basis, checks: [{ ...coverage(context.contract).checks[0]!, evidence: [{ procedure: "Independent source inspection and regression output", cwd, runtime: "node20", sourceDigest: binding.sourceDigest, reference: context.contract.baseline[0]?.evidenceDigest ?? "source-inspection-evidence" }] }] };
          const response = { text: `RAFI_QA_COVERAGE_START\n${JSON.stringify(claim)}\nRAFI_QA_COVERAGE_END\nSTEP_STATUS: qa_pass | summary="Independent verification"`, isError: false, numTurns: 1, costUsd: 0, turnId: "native-review", providerMetadata: { provider: "claude" as const, sessionId: ref.sessionId, sessionRef: ref } }; events.push({ kind: "turn-complete", turnId: response.turnId, result: response }); await new Promise(resolve => setImmediate(resolve)); return response;
        } };
        assert.equal((await import("node:fs")).existsSync(join(cwd, ".rafi", "compiled", "qa")), false, "Ignored compiled bundle is absent from disposable source snapshot");
        const effective = resolveEffectiveQaConfiguration(f.root, { make: "claude" });
        assert.ok(effective.qaRules.includes("Canonical qa sentinel"));
        return describeQaRuntimeHandle(adapter, { settings: { role: "qa", source: "project", make: "claude", model: "fixture", reasoning: "default", fast: false, session_strategy: "fresh", settings_revision: 1, display_session_cost: false, auto_compact_threshold_percent: 50, compact_maximum: 2 }, effectiveRoleInstructions: finalQaRoleInstructions(effective.qaRules), skills: effective.skills.map(skill => ({ ...skill, digest: (awaitCryptoDigest(skill.content)) })) }, { kind: "initial" });
      } });
    if (blocked) {
      await assert.rejects(pending, /retained ready contract|frozen admitted scope/);
      assert.equal(reviews, 0, "Stale or missing contract never dispatches final review or preparation");
      assert.equal(f.store.budget("run", f.workId, f.admission.requirementsDigest)!.reservations.length, 0);
    } else {
      const result = await pending;
      assert.equal(result.outcome, "passed", result.detail); assert.equal(reviews, 1); assert.ok(result.passCertificateId);
      const reviewDigest = f.db.qaTicketHead("run", f.workId).reviewBasisDigest!;
      const sample = { contractDigest: f.contract.contentDigest, reviewDigest, assessor: "independent-usefulness-assessor", coverageAdequate: true, checkUsefulness: [{ checkId: "check", result: "Guided verification", observation: "The expiry expectation directed independent source inspection; no defect found is not proof of redundancy" }] };
      const evidence = f.store.putArtifact("sample-input-evidence", { inputs: f.contract.inputs, investigation: f.contract.preparationEvidence, reviewDigest });
      assert.throws(() => f.store.metric("run", f.workId, f.admission.requirementsDigest, "bad-sample", "sample", { sample: { ...sample, reviewDigest: digest }, evidenceRefs: [evidence] }), /retained terminal review/);
      f.store.metric("run", f.workId, f.admission.requirementsDigest, "sampled-review", "sample", { sample, costUsd: null, durationMs: 100, evidenceRefs: [evidence] });
      const observation = f.store.metrics("run").samples[0]!;
      assert.equal(observation.level, 2); assert.equal(observation.costUsd, null); assert.equal(observation.durationMs, 100); assert.equal(observation.checkUsefulness![0]!.checkId, "check");
    }
  } finally { f.cleanup(); }
});
function awaitCryptoDigest(content: string): string { return createHash("sha256").update(content).digest("hex"); }

test("whole-work waiver requires the existing actual operator confirmation, enumerates checks and stays distinct from pass", () => {
  const f = fixture();
  try {
    let head = f.db.qaTicketHead("run", f.workId); head = f.db.transitionQa("run", f.workId, head.revision, { type: "source-frozen", sourceStateDigest: digest }); head = f.db.transitionQa("run", f.workId, head.revision, { type: "review-ready", reviewBasisDigest: digest, sessionGeneration: 0 }); head = f.db.transitionQa("run", f.workId, head.revision, { type: "turn-intended", slot: "initial" }); head = f.db.transitionQa("run", f.workId, head.revision, { type: "review-failed", reportDigest: digest });
    assert.throws(() => f.db.commitQaWaiver("run", f.workId, head.revision, "Agent explanation"), /authorization/);
    const decision = f.db.ensureHumanDecision({ runId: "run", decisionKey: "run:qa-nonconvergence:fixture:waiver", interruptionId: `ticket:${f.workId}`, prompt: "T1: QA waiver confirmation: retain unresolved findings?", choices: [{ id: "yes", label: "Waive and continue" }] });
    assert.throws(() => f.db.authorizeContractQaWaiver("run", f.workId, decision.decisionId), /actual answered/);
    f.db.answerHumanDecision("run", decision.decisionId, "yes"); const authorizationRef = f.db.authorizeContractQaWaiver("run", f.workId, decision.decisionId);
    const result = f.db.commitQaWaiver("run", f.workId, head.revision, "Operator accepted whole-work verification exception", undefined, authorizationRef); assert.equal(result.state, "waived"); assert.equal(result.passCertificateId, undefined);
    const receipt = f.store.eventRecord<{ mandatoryCheckIds: string[]; completion: string; decisionId: string }>(`whole-work-waiver:run:${f.workId}:${head.revision}`)!; assert.deepEqual(receipt.mandatoryCheckIds, ["check"]); assert.equal(receipt.completion, "waived"); assert.equal(receipt.decisionId, decision.decisionId);
  } finally { f.cleanup(); }
});

test("supported finding causes bind a real retained finding, its review basis and scoped independent assessment", () => {
  const f = fixture();
  try {
    const report: import("rafi-spec").QaFailureReportV1 = { version: 1, summary: "Expiry boundary is missing", checks_run: [{ check: "expiry", outcome: "failed", evidence: "Expired token accepted" }], findings: [{ id: "expiry", requirement: "Reject expired token", locations: ["product.txt:1"], problem: "Expired token accepted", evidence: "Observed expiry failure", expected: "Reject expired token", fix_direction: "Inspect expiry boundary", verification: ["Verify expired-token rejection"] }], observations: [] };
    const reviewDigest = qaReportDigest(report), fields = { version: 2 as const, contractBinding: { version: 1 as const, transportVersion: 1 as const, revision: 1, digest: f.contract.contentDigest, admissionDigest: f.admission.requirementsDigest, commonConfigDigest: f.contract.inputs.find(input => input.kind === "rules")!.digest }, ticketDigest: qaDigest("ticket", f.ticket), instructionDigest: digest, roleInstructionsDigest: digest, skillsDigest: digest, runtimeDigest: digest, validationChecklistDigest: digest, confinementDigest: digest };
    const basis = { ...fields, digest: qaDigest("review-basis-fields", fields) };
    f.db.putQaReviewBasis("run", f.workId, basis);
    f.db.beginQaReviewAttempt({ attemptId: "finding-review", runId: "run", ticketId: f.workId, reviewNumber: 1, cycle: 1, remediationGeneration: 0, sourceDigest: digest });
    f.db.finishQaReviewAttempt("finding-review", { status: "failed", reportDigest: reviewDigest, namespacedFindingIds: ["scoped-expiry-finding"] });
    f.db.recordQaReport({ runId: "run", ticketId: f.workId, reviewNumber: 1, reportDigest: reviewDigest, sourceStateDigest: digest, reviewBasisDigest: basis.digest, report }, ["scoped-expiry-finding"]);
    const evidence = f.store.putArtifact("finding-classification-input", { report, contract: f.contract });
    const assessment: import("../src/qaPreparationMetrics.js").FindingAssessmentV1 = { version: 1, findingId: "scoped-expiry-finding", contractDigest: f.contract.contentDigest, reviewDigest, assessor: "independent-cause-assessor", independent: true, cause: "preparation-omission", explanation: "The retained inputs made the exact expiry boundary knowable and actionable", knowableBeforeImplementation: true, actionableBeforeImplementation: true, expectedCheckIds: ["check"], originalInputEvidence: [evidence], builderEvidence: [], scopeAuthorityEvidence: [] };
    assert.throws(() => f.store.findingAssessment("run", f.workId, f.admission.requirementsDigest, { ...assessment, findingId: "invented-finding" }, [evidence]), /retained report/);
    assert.throws(() => f.store.findingAssessment("run", f.workId, f.admission.requirementsDigest, { ...assessment, actionableBeforeImplementation: null }, [evidence]), /knowable and actionable/);
    const assessmentRef = f.store.findingAssessment("run", f.workId, f.admission.requirementsDigest, assessment, [evidence]);
    assert.ok(assessmentRef); assert.equal(f.store.metrics("run").causes["preparation-omission"], 1);
    assert.throws(() => f.store.metric("run", f.workId, f.admission.requirementsDigest, "forged-classification", "finding-classification", { findingId: "invented-finding", classifier: assessment.assessor, cause: assessment.cause, confidence: "supported", assessmentRef, evidenceRefs: [evidence] }), /exact scoped assessment/);
  } finally { f.cleanup(); }
});
