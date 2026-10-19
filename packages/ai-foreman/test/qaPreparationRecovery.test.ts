import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { enforceMandatoryCoverage, normalizeAssessmentMetadata, prepareVerificationContract } from "../src/qaPreparation.js";
import { preparationTurnPayload } from "../src/qaBuildGate.js";
import { mapSnapshotWorkingDirectories, normalizeSnapshotPaths } from "../src/qaVerificationContract.js";
import { assessment, candidate, storeFixture } from "./qaPreparationFixtures.js";

const envelope = (tag: string, value: unknown) => `${tag}_START\n${JSON.stringify(value)}\n${tag}_END`;

test("received continuity defects retain the provider response for bounded parsing", () => {
  const response = envelope("RAFI_QA_CANDIDATE", candidate());
  const payload = preparationTurnPayload({
    text: "QA continuity record was invalid: missing continuity marker",
    rawResponse: response,
    cleanedResponse: response,
    isError: true,
    continuityErrors: ["missing continuity marker"],
    numTurns: 1,
    costUsd: 0,
  });
  assert.equal(payload.text, response);
  assert.deepEqual(payload.formatErrors, ["missing continuity marker"]);
});

test("extra policy note is non-authoritative and does not alter assessment requirements or concerns", () => {
  const original = { ...assessment(candidate()), policyVersion_note: "explanatory note", unexpectedAuthority: "must remain subject to schema validation" };
  const normalized = normalizeAssessmentMetadata(original);
  assert.equal(Object.hasOwn(normalized, "policyVersion_note"), false);
  assert.equal(normalized.policyVersion, original.policyVersion);
  assert.deepEqual(normalized.concerns, original.concerns);
  assert.deepEqual(normalized.assessedRequirementIds, original.assessedRequirementIds);
  assert.equal(normalized.unexpectedAuthority, original.unexpectedAuthority);
  assert.equal(original.policyVersion_note, "explanatory note");
});

test("mandatory requirements promote an existing advisory covering check", () => {
  const original = candidate();
  const mandatoryRequirement = original.requirements.find(requirement => requirement.obligation === "mandatory")!;
  const covering = original.checks.find(check => check.requirementRefs.includes(mandatoryRequirement.id))!;
  covering.obligation = "advisory";
  const normalized = enforceMandatoryCoverage(original);
  assert.equal(normalized.checks.find(check => check.id === covering.id)?.obligation, "mandatory");
  assert.equal(original.checks.find(check => check.id === covering.id)?.obligation, "advisory");
});

test("explicit coverage retains its requirement link on the covering check", () => {
  const original = candidate();
  const requirement = original.requirements[0]!;
  const check = original.checks.find(item => item.id === original.coverage.find(row => row.requirementId === requirement.id)!.checkIds[0])!;
  check.requirementRefs = check.requirementRefs.filter(id => id !== requirement.id);
  const normalized = enforceMandatoryCoverage(original);
  assert.ok(normalized.checks.find(item => item.id === check.id)?.requirementRefs.includes(requirement.id));
  assert.ok(!original.checks.find(item => item.id === check.id)?.requirementRefs.includes(requirement.id));
});

test("assessment schema drift is repaired without accepting copied preparation evidence", async () => {
  const { db, store } = storeFixture();
  const initial = candidate(); initial.checks = []; initial.coverage = []; initial.preparationEvidence = [];
  let assessmentCalls = 0, repairCalls = 0;
  try {
    const result = await prepareVerificationContract(initial, initial.requirements, {
      store, now: () => 1000, inputsCurrent: () => true,
      normalizeDraft: draft => { for (const evidence of draft.preparationEvidence) { evidence.evidenceDigest = "a".repeat(64); for (const reference of evidence.references) reference.digest = "a".repeat(64); } return draft; },
      dispatch: async (phase, _instruction, operationId) => {
        if (phase === "prepare") {
          const draft = candidate();
          for (const evidence of draft.preparationEvidence) { evidence.operationId = operationId; evidence.sessionId = "author"; }
          return { text: envelope("RAFI_QA_CANDIDATE", { checks: draft.checks, coverage: draft.coverage, baseline: draft.baseline, preparationEvidence: draft.preparationEvidence.map(({ obligation, references, analysis }) => ({ obligation, references: references.map(({ path, locator }) => ({ path, locator })), analysis })), unresolved: draft.unresolved }), sessionId: "author" };
        }
        if (phase === "assess") {
          assessmentCalls++;
          return { text: envelope("RAFI_QA_ASSESSMENT", { ...assessment(candidate()), preparationEvidence: candidate().preparationEvidence }), sessionId: "assessor" };
        }
        assert.equal(phase, "repair"); repairCalls++;
        const clean = assessment(candidate()); clean.operationId = operationId;
        return { text: envelope("RAFI_QA_ASSESSMENT", clean), sessionId: "assessor-repair" };
      },
    });
    assert.equal(result.status, "ready", JSON.stringify(result));
    assert.equal(assessmentCalls, 1);
    assert.equal(repairCalls, 1);
  } finally { db.close(); }
});

test("host restores its metadata and requirements, then requests correction of invalid coverage", async () => {
  const { db, store } = storeFixture();
  const initial = candidate(); initial.checks = []; initial.coverage = []; initial.preparationEvidence = [];
  let prepared = candidate(), prepareCalls = 0;
  try {
    const result = await prepareVerificationContract(initial, initial.requirements, {
      store, now: () => 1000, inputsCurrent: () => true, hostFacts: "Host graph test fact; external Graphify status is separate.",
      dispatch: async (phase, instruction, operationId) => {
        assert.match(instruction, /Different named files or an extra relevant file do not by themselves create a material conflict/);
        assert.match(instruction, /Host graph test fact; external Graphify status is separate/);
        assert.match(instruction, /Do not disregard explicit user-established security/);
        assert.match(instruction, /not a Builder acceptance criterion or a material conflict/);
        assert.match(instruction, /do not require the host to amend the plan before building/);
        assert.match(instruction, /Do not invent mandatory inline node -e or node --eval commands/);
        assert.match(instruction, /Do not invent a mandatory test-first RED phase/);
        assert.match(instruction, /When an original requirement actually requires a historical sequence, preserve it/);
        assert.match(instruction, /independent QA snapshot may have a detached HEAD/);
        assert.match(instruction, /captured pre-implementation baseline/);
        assert.match(instruction, /do not invent a mandatory branch-alone execution check/);
        assert.match(instruction, /Preserve explicitly requested procedures/);
        if (phase === "prepare" || phase === "repair") {
          assert.match(instruction, /verify that rollback restores behavior/);
          assert.match(instruction, /rafi qa-rehearse-rollback/);
          assert.match(instruction, /Do not assume copying files to external scratch/);
          assert.match(instruction, /Never perform destructive rollback/);
          prepareCalls++;
          prepared = candidate();
          if (prepareCalls === 1) {
            prepared.createdAt = "2026-11-01T00:00:00Z";
            prepared.predecessorDigest = "b".repeat(64);
            prepared.requirements[0]!.statement = "Provider summary";
            prepared.checks[0]!.requirementRefs = ["unknown"];
          } else {
            assert.match(instruction, /Unknown requirement on check/);
            assert.match(instruction, /Targeted QA contract repair only/);
            const previous = JSON.parse(instruction.split("Authoritative candidate/input inventory:\n")[1]!);
            assert.equal(previous.createdAt, initial.createdAt);
            assert.equal(previous.predecessorDigest, undefined);
            assert.deepEqual(previous.requirements, initial.requirements);
            assert.deepEqual(previous.unresolved, []);
          }
          for (const evidence of prepared.preparationEvidence) { evidence.operationId = operationId; evidence.sessionId = "author"; }
          return { text: envelope("RAFI_QA_CANDIDATE", prepared), sessionId: "author" };
        }
        assert.equal(phase, "assess");
        return { text: envelope("RAFI_QA_ASSESSMENT", { ...assessment(prepared), policyVersion_note: "No change to the required assessment." }), sessionId: "assessor" };
      },
    });
    assert.equal(result.status, "ready", JSON.stringify(result));
    assert.equal(prepareCalls, 2);
  } finally { db.close(); }
});

test("changed approved inputs still block preparation", async () => {
  const { db, store } = storeFixture();
  const initial = candidate(); initial.checks = []; initial.coverage = []; initial.preparationEvidence = [];
  try {
    const result = await prepareVerificationContract(initial, initial.requirements, {
      store, now: () => 1000, inputsCurrent: () => true,
      dispatch: async () => { const draft = candidate(); draft.inputs[0]!.digest = "b".repeat(64); return { text: envelope("RAFI_QA_CANDIDATE", draft), sessionId: "author" }; },
    });
    assert.equal(result.status, "incomplete");
    if (result.status === "incomplete") assert.match(result.detail, /host-owned/);
  } finally { db.close(); }
});

test("provider-only draft needs no model-generated hashes or copied authority", async () => {
  const { db, store } = storeFixture();
  const initial = candidate(); initial.checks = []; initial.coverage = []; initial.preparationEvidence = [];
  let assembled = candidate();
  try {
    const result = await prepareVerificationContract(initial, initial.requirements, {
      store, now: () => 1000, inputsCurrent: () => true,
      normalizeDraft: (draft, response) => {
        for (const evidence of draft.preparationEvidence) {
          evidence.evidenceDigest = "a".repeat(64);
          for (const reference of evidence.references) reference.digest = "a".repeat(64);
          evidence.operationId = response.operationId!; evidence.sessionId = response.sessionId;
        }
        assembled = draft; return draft;
      },
      dispatch: async (phase, instruction) => {
        if (phase === "prepare") {
          assert.match(instruction, /you do not need shell access or hash calculations/);
          const full = candidate();
          return { sessionId: "author", text: envelope("RAFI_QA_CANDIDATE", { checks: full.checks, coverage: full.coverage, baseline: [], unresolved: [], preparationEvidence: full.preparationEvidence.map(({ obligation, references, analysis }) => ({ obligation, analysis, references: references.map(({ path, locator }) => ({ path, locator })) })) }) };
        }
        return { sessionId: "assessor", text: envelope("RAFI_QA_ASSESSMENT", assessment(assembled)) };
      },
    });
    assert.equal(result.status, "ready", JSON.stringify(result));
    if (result.status === "ready") {
      assert.deepEqual(result.contract.inputs, initial.inputs);
      assert.deepEqual(result.contract.depthDecision, initial.depthDecision);
      assert.equal(result.contract.preparationEvidence[0]!.references[0]!.digest, "a".repeat(64));
    }
  } finally { db.close(); }
});

test("provider refusal is reported directly without format-repair dispatch", async () => {
  const { db, store } = storeFixture();
  const initial = candidate(); initial.checks = []; initial.coverage = []; initial.preparationEvidence = [];
  let calls = 0;
  try {
    const result = await prepareVerificationContract(initial, initial.requirements, {
      store, now: () => 1000, inputsCurrent: () => true,
      dispatch: async () => { calls++; return { sessionId: "author", text: "I cannot calculate SHA-256 hashes because shell access was denied; RAFI_QA_CANDIDATE_START ` / ` RAFI_QA_CANDIDATE_END" }; },
    });
    assert.equal(result.status, "incomplete");
    if (result.status === "incomplete") assert.match(result.detail, /could not produce.*cannot calculate SHA-256/);
    assert.equal(calls, 1);
  } finally { db.close(); }
});

test("format repair retains original investigation provenance", async () => {
  const { db, store } = storeFixture();
  const initial = candidate(); initial.checks = []; initial.coverage = []; initial.preparationEvidence = [];
  let prepared = candidate(), investigationId = "";
  try {
    const result = await prepareVerificationContract(initial, initial.requirements, {
      store, now: () => 1000, inputsCurrent: () => true,
      normalizeDraft: (draft, response) => { assert.equal(response.operationId, investigationId); assert.equal(response.sessionId, "author"); return draft; },
      dispatch: async (phase, _instruction, operationId) => {
        if (phase === "prepare") { investigationId = operationId; return { sessionId: "author", text: JSON.stringify(prepared) }; }
        if (phase === "repair") return { sessionId: "formatter", text: envelope("RAFI_QA_CANDIDATE", prepared) };
        for (const evidence of prepared.preparationEvidence) { evidence.operationId = investigationId; evidence.sessionId = "author"; }
        return { sessionId: "assessor", text: envelope("RAFI_QA_ASSESSMENT", assessment(prepared)) };
      },
    });
    assert.equal(result.status, "ready", JSON.stringify(result));
    if (result.status === "ready") assert.ok(result.contract.preparationEvidence.every(item => item.operationId === investigationId && item.sessionId === "author"));
  } finally { db.close(); }
});

test("prose-only preparation output receives bounded format repair", async () => {
  const { db, store } = storeFixture();
  const initial = candidate(); initial.checks = []; initial.coverage = []; initial.preparationEvidence = [];
  let repairCalls = 0;
  const prepared = candidate();
  try {
    const result = await prepareVerificationContract(initial, initial.requirements, {
      store, now: () => 1000, inputsCurrent: () => true,
      normalizeDraft: draft => { for (const evidence of draft.preparationEvidence) { evidence.evidenceDigest = "b".repeat(64); for (const reference of evidence.references) reference.digest = "a".repeat(64); } return draft; },
      dispatch: async (phase) => {
        if (phase === "prepare") return { sessionId: "author", text: "I’m preparing the requested QA review now." };
        if (phase === "repair") { repairCalls++; return { sessionId: "formatter", text: envelope("RAFI_QA_CANDIDATE", { checks: prepared.checks, coverage: prepared.coverage, baseline: [], unresolved: [], preparationEvidence: prepared.preparationEvidence.map(({ obligation, references, analysis }) => ({ obligation, analysis, references: references.map(({ path, locator }) => ({ path, locator })) })) }) }; }
        return { sessionId: "assessor", text: envelope("RAFI_QA_ASSESSMENT", assessment(prepared)) };
      },
    });
    assert.equal(result.status, "ready", JSON.stringify(result));
    assert.equal(repairCalls, 1);
  } finally { db.close(); }
});

test("legacy formatting differences do not become host authority", async () => {
  const { db, store } = storeFixture();
  const initial = candidate(); initial.inputs[0]!.reference = "/project/plan.md"; initial.depthDecision.rationale = "Inspected ordinary `behavior` and tests"; initial.checks = []; initial.coverage = []; initial.preparationEvidence = [];
  let prepared = candidate();
  try {
    const result = await prepareVerificationContract(initial, initial.requirements, {
      store, now: () => 1000, inputsCurrent: () => true,
      dispatch: async (phase, _instruction, operationId) => {
        if (phase === "prepare") {
          prepared = candidate(); prepared.inputs[0]!.reference = "plan.md";
          for (const evidence of prepared.preparationEvidence) { evidence.operationId = operationId; evidence.sessionId = "author"; }
          return { text: envelope("RAFI_QA_CANDIDATE", prepared), sessionId: "author" };
        }
        prepared.inputs = structuredClone(initial.inputs); prepared.depthDecision = structuredClone(initial.depthDecision);
        return { text: envelope("RAFI_QA_ASSESSMENT", assessment(prepared)), sessionId: "assessor" };
      },
    });
    assert.equal(result.status, "ready", JSON.stringify(result));
    if (result.status === "ready") { assert.deepEqual(result.contract.inputs, initial.inputs); assert.deepEqual(result.contract.depthDecision, initial.depthDecision); }
  } finally { db.close(); }
});

test("legacy changes to selected depth are rejected", async () => {
  const { db, store } = storeFixture();
  const initial = candidate(); initial.checks = []; initial.coverage = []; initial.preparationEvidence = [];
  try {
    const result = await prepareVerificationContract(initial, initial.requirements, {
      store, now: () => 1000, inputsCurrent: () => true,
      dispatch: async () => { const draft = candidate(); draft.depthDecision.level = 1; return { sessionId: "author", text: envelope("RAFI_QA_CANDIDATE", draft) }; },
    });
    assert.equal(result.status, "incomplete");
    if (result.status === "incomplete") assert.match(result.detail, /host-owned/);
  } finally { db.close(); }
});

test("legacy substantive risk rationale changes are rejected", async () => {
  const { db, store } = storeFixture();
  const initial = candidate(); initial.checks = []; initial.coverage = []; initial.preparationEvidence = [];
  try {
    const result = await prepareVerificationContract(initial, initial.requirements, {
      store, now: () => 1000, inputsCurrent: () => true,
      dispatch: async () => { const draft = candidate(); draft.depthDecision.rationale = "The work requires a different risk assessment"; return { sessionId: "author", text: envelope("RAFI_QA_CANDIDATE", draft) }; },
    });
    assert.equal(result.status, "incomplete");
    if (result.status === "incomplete") assert.match(result.detail, /host-owned/);
  } finally { db.close(); }
});

test("changed authoritative source prevents publishing an otherwise valid draft", async () => {
  const { db, store } = storeFixture();
  const initial = candidate(); initial.checks = []; initial.coverage = []; initial.preparationEvidence = [];
  const prepared = candidate();
  try {
    const result = await prepareVerificationContract(initial, initial.requirements, {
      store, now: () => 1000, inputsCurrent: () => false,
      dispatch: async (phase, _instruction, operationId) => {
        if (phase === "prepare") { for (const evidence of prepared.preparationEvidence) { evidence.operationId = operationId; evidence.sessionId = "author"; } return { sessionId: "author", text: envelope("RAFI_QA_CANDIDATE", prepared) }; }
        return { sessionId: "assessor", text: envelope("RAFI_QA_ASSESSMENT", assessment(prepared)) };
      },
    });
    assert.equal(result.status, "incomplete");
    if (result.status === "incomplete") assert.match(result.detail, /inputs changed before publication/);
    assert.notEqual(store.head(initial.runId, initial.workId, initial.admissionDigest).state, "ready");
  } finally { db.close(); }
});

test("legacy provider cannot introduce new or duplicate approved requirements", async () => {
  for (const duplicate of [false, true]) {
    const { db, store } = storeFixture();
    const initial = candidate(); initial.checks = []; initial.coverage = []; initial.preparationEvidence = [];
    try {
      const result = await prepareVerificationContract(initial, initial.requirements, {
        store, now: () => 1000, inputsCurrent: () => true,
        dispatch: async () => { const draft = candidate(); draft.requirements.push({ ...draft.requirements[0]!, id: duplicate ? "req" : "invented" }); return { sessionId: "author", text: envelope("RAFI_QA_CANDIDATE", draft) }; },
      });
      assert.equal(result.status, "incomplete");
      if (result.status === "incomplete") assert.match(result.detail, /unknown or duplicate requirement/);
    } finally { db.close(); }
  }
});

test("malformed provider-only drafts get bounded specific correction feedback", async () => {
  const { db, store } = storeFixture();
  const initial = candidate(); initial.checks = []; initial.coverage = []; initial.preparationEvidence = [];
  let calls = 0;
  try {
    const result = await prepareVerificationContract(initial, initial.requirements, {
      store, now: () => 1000, inputsCurrent: () => true, normalizeDraft: draft => draft,
      dispatch: async (_phase, instruction) => {
        calls++;
        if (calls === 2) assert.match(instruction, /must have required property 'checks'/);
        return { sessionId: "author", text: envelope("RAFI_QA_CANDIDATE", { checks: undefined, coverage: [], baseline: [], preparationEvidence: [], unresolved: [] }) };
      },
    });
    assert.equal(result.status, "incomplete");
    if (result.status === "incomplete") assert.match(result.detail, /draft correction exhausted/);
    assert.equal(calls, 2);
  } finally { db.close(); }
});

test("invalid coverage remains blocked after the bounded correction attempts", async () => {
  const { db, store } = storeFixture();
  const initial = candidate(); initial.checks = []; initial.coverage = []; initial.preparationEvidence = [];
  let calls = 0;
  try {
    const result = await prepareVerificationContract(initial, initial.requirements, {
      store, now: () => 1000, inputsCurrent: () => true,
      dispatch: async () => { calls++; const draft = candidate(); draft.checks[0]!.requirementRefs = ["unknown"]; return { text: envelope("RAFI_QA_CANDIDATE", draft), sessionId: "author" }; },
    });
    assert.equal(result.status, "incomplete");
    if (result.status === "incomplete") assert.match(result.detail, /Invalid coverage|Unknown requirement on check/);
    assert.equal(calls, 2);
    const retry = await prepareVerificationContract(initial, initial.requirements, {
      store, now: () => 1000, inputsCurrent: () => true,
      dispatch: async () => { throw new Error("exhausted budget must not dispatch"); },
    });
    assert.equal(retry.status, "incomplete");
    if (retry.status === "incomplete") assert.match(retry.detail, /allowance exhausted/);
  } finally { db.close(); }
});

test("snapshot path conversion excludes outside directories and escaping symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-qa-path-test-"));
  try {
    const snapshot = join(root, "snapshot"), inside = join(snapshot, "tests"), outside = join(root, "outside");
    mkdirSync(snapshot); mkdirSync(inside); mkdirSync(outside); symlinkSync(outside, join(snapshot, "escape"));
    const draft = candidate();
    draft.checks[0]!.verification = [snapshot, inside, outside, join(snapshot, "escape")].map(cwd => ({ kind: "command", argv: ["node"], cwd, fixtures: [], expectedOutcome: "Pass", runtime: "node", timeoutMs: 1000 }));
    const mapping = mapSnapshotWorkingDirectories(envelope("RAFI_QA_CANDIDATE", draft), snapshot);
    assert.deepEqual(mapping, { [snapshot]: ".", [inside]: "tests" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("provider snapshot paths normalize to stable host-owned locations", () => {
  const stale = "/private/var/folders/g1/tmp/rafi-qa-zI70FH";
  const text = `cwd=${stale} scratch=${stale}/scratch/red-phase.log`;
  assert.equal(normalizeSnapshotPaths(text), "cwd=. scratch=scratch/red-phase.log");
});
