import { nativeFixtureTurn } from "./helpers/nativeOutput.js";
import { nativePolicy } from "../src/structuredOperation.js";
import type { OutputContract } from "rafi-spec";
import type { PreparationDependencies } from "../src/qaPreparation.js";
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

function providerDraft(full = candidate()) {
  return { kind: "draft" as const, checks: full.checks, coverage: full.coverage, baseline: [], unresolved: full.unresolved,
    preparationEvidence: full.preparationEvidence.map(({ obligation, references, analysis }) => ({ obligation, analysis, references: references.map(({ path, locator }) => ({ path, locator })) })) };
}
function providerAssessment(full = candidate()) {
  const { draftPayloadDigest, inventoryDigest, policyVersion, operationId, sessionId, authorSessionId, ...payload } = assessment(full);
  return payload;
}
function reply(output: OutputContract, operationId: string, payload: unknown, sessionId = "author", alternative?: unknown) {
  return { ...nativeFixtureTurn(nativePolicy(output, { dispatchId: operationId }), sessionId, payload, "claude", alternative), sessionId };
}
const normalizeDraft: NonNullable<PreparationDependencies["normalizeDraft"]> = (draft, response) => {
  for (const evidence of draft.preparationEvidence) {
    evidence.operationId = response.operationId!; evidence.sessionId = response.sessionId; evidence.evidenceDigest = "a".repeat(64);
    for (const reference of evidence.references) reference.digest = "a".repeat(64);
  }
  return draft;
};

test("malformed assessment is retained without copying preparation evidence or sending a format repair", async () => {
  const { db, store } = storeFixture(); const initial = candidate(); let calls = 0;
  try {
    const result = await prepareVerificationContract(initial, initial.requirements, { store, normalizeDraft, now: () => 1000, inputsCurrent: () => true,
      dispatch: async (phase, _instruction, id, _ms, output) => {
        calls++;
        return reply(output, id, phase === "prepare" ? providerDraft() : { ...providerAssessment(), preparationEvidence: initial.preparationEvidence }, phase === "prepare" ? "author" : "assessor");
      } });
    assert.equal(result.status, "incomplete"); assert.equal(calls, 2);
    assert.notEqual(store.head(initial.runId, initial.workId, initial.admissionDigest).state, "ready");
    assert.equal(store.budget(initial.runId, initial.workId, initial.admissionDigest)!.reservations.length, 2);
  } finally { db.close(); }
});

test("semantic coverage correction retains host metadata and original source requirements", async () => {
  const { db, store } = storeFixture(); const initial = candidate(); let prepares = 0; let normalized = initial;
  try {
    const result = await prepareVerificationContract(initial, initial.requirements, { store, now: () => 1000, inputsCurrent: () => true,
      hostFacts: "Host graph test fact; external Graphify status is separate.",
      normalizeDraft: (draft, response) => normalized = normalizeDraft(draft, response),
      dispatch: async (phase, instruction, id, _ms, output) => {
        assert.match(instruction, /Different named files or an extra relevant file do not by themselves create a material conflict/);
        assert.match(instruction, /Host graph test fact; external Graphify status is separate/);
        assert.match(instruction, /Do not disregard explicit user-established security/);
        assert.match(instruction, /not a Builder acceptance criterion or a material conflict/);
        assert.match(instruction, /Do not invent mandatory inline node -e or node --eval commands/);
        assert.match(instruction, /Do not invent a mandatory test-first RED phase/);
        assert.match(instruction, /When an original requirement actually requires a historical sequence, preserve it/);
        assert.match(instruction, /independent QA snapshot may have a detached HEAD/);
        assert.match(instruction, /Preserve explicitly requested procedures/);
        if (phase === "assess") return reply(output, id, providerAssessment(normalized), "assessor");
        prepares++;
        assert.match(instruction, /Never perform destructive rollback/);
        const draft = providerDraft();
        if (prepares === 1) draft.checks[0]!.requirementRefs = ["unknown"];
        else {
          assert.match(instruction, /Unknown requirement on check/);
          assert.match(instruction, /Targeted QA contract repair only/);
          const previous = JSON.parse(instruction.split("Authoritative candidate/input inventory:\n")[1]!);
          assert.equal(previous.createdAt, initial.createdAt); assert.deepEqual(previous.requirements, initial.requirements);
        }
        return reply(output, id, draft);
      } });
    assert.equal(result.status, "ready", JSON.stringify(result)); assert.equal(prepares, 2);
    if (result.status === "ready") { assert.deepEqual(result.contract.inputs, initial.inputs); assert.deepEqual(result.contract.depthDecision, initial.depthDecision); }
  } finally { db.close(); }
});

for (const [field, value] of Object.entries({ inputs: [{ digest: "b".repeat(64) }], depthDecision: { level: 1, rationale: "new risk" }, requirements: [{ id: "invented" }, { id: "invented" }], createdAt: "2026-11-01", predecessorDigest: "b".repeat(64) })) {
  test(`provider cannot introduce host-owned ${field} into a native draft`, async () => {
    const { db, store } = storeFixture(); const initial = candidate(); let calls = 0;
    try {
      const result = await prepareVerificationContract(initial, initial.requirements, { store, normalizeDraft, now: () => 1000, inputsCurrent: () => true,
        dispatch: async (_phase, _instruction, id, _ms, output) => { calls++; return reply(output, id, { ...providerDraft(), [field]: value }); } });
      assert.equal(result.status, "incomplete"); assert.equal(calls, 1);
      if (result.status === "incomplete") assert.match(result.detail, /contract|additional|unknown/i);
      assert.notEqual(store.head(initial.runId, initial.workId, initial.admissionDigest).state, "ready");
    } finally { db.close(); }
  });
}

test("provider-only draft needs no hashes and preserves actual investigation provenance", async () => {
  const { db, store } = storeFixture(); const initial = candidate(); let normalized = initial; let investigationId = "";
  try {
    const result = await prepareVerificationContract(initial, initial.requirements, { store, now: () => 1000, inputsCurrent: () => true,
      normalizeDraft: (draft, response) => { assert.equal(response.operationId, investigationId); return normalized = normalizeDraft(draft, response); },
      dispatch: async (phase, instruction, id, _ms, output) => {
        if (phase === "prepare") { investigationId = id; assert.match(instruction, /you do not need shell access or hash calculations/); return reply(output, id, providerDraft()); }
        assert.equal(phase, "assess"); return reply(output, id, providerAssessment(normalized), "assessor");
      } });
    assert.equal(result.status, "ready", JSON.stringify(result));
    if (result.status === "ready") for (const evidence of result.contract.preparationEvidence) { assert.equal(evidence.operationId, investigationId); assert.equal(evidence.sessionId, "author"); assert.equal(evidence.references[0]!.digest, "a".repeat(64)); }
  } finally { db.close(); }
});

test("typed provider blocker is reported directly without a formatting dispatch", async () => {
  const { db, store } = storeFixture(); const initial = candidate(); let calls = 0;
  try {
    const result = await prepareVerificationContract(initial, initial.requirements, { store, now: () => 1000, inputsCurrent: () => true,
      dispatch: async (_phase, _instruction, id, _ms, output) => { calls++; return reply(output, id, undefined, "author", { kind: "blocked", reason: "Required source is inaccessible", nextAction: "Restore source access" }); } });
    assert.equal(result.status, "incomplete"); assert.equal(calls, 1);
    if (result.status === "incomplete") assert.match(result.detail, /Required source is inaccessible/);
  } finally { db.close(); }
});

for (const text of ["Preparing the requested review now", envelope("RAFI_QA_CANDIDATE", candidate()), JSON.stringify(candidate())]) test(`legacy output cannot enter native preparation: ${text.slice(0, 35)}`, async () => {
  const { db, store } = storeFixture(); const initial = candidate(); let calls = 0;
  try {
    const result = await prepareVerificationContract(initial, initial.requirements, { store, now: () => 1000, inputsCurrent: () => true, dispatch: async () => { calls++; return { sessionId: "author", text }; } });
    assert.equal(result.status, "incomplete"); assert.equal(calls, 1);
    if (result.status === "incomplete") assert.match(result.detail, /no sealed v2 dispatch tuple/);
  } finally { db.close(); }
});

test("changed authoritative source prevents publishing an otherwise valid native draft", async () => {
  const { db, store } = storeFixture(); const initial = candidate(); let normalized = initial;
  try {
    const result = await prepareVerificationContract(initial, initial.requirements, { store, now: () => 1000, inputsCurrent: () => false,
      normalizeDraft: (draft, response) => normalized = normalizeDraft(draft, response),
      dispatch: async (phase, _instruction, id, _ms, output) => reply(output, id, phase === "prepare" ? providerDraft() : providerAssessment(normalized), phase === "prepare" ? "author" : "assessor") });
    assert.equal(result.status, "incomplete"); if (result.status === "incomplete") assert.match(result.detail, /inputs changed before publication/);
    assert.notEqual(store.head(initial.runId, initial.workId, initial.admissionDigest).state, "ready");
  } finally { db.close(); }
});

test("missing draft fields stop immediately with retained schema diagnostics", async () => {
  const { db, store } = storeFixture(); const initial = candidate(); let calls = 0;
  try {
    const result = await prepareVerificationContract(initial, initial.requirements, { store, now: () => 1000, inputsCurrent: () => true,
      dispatch: async (_phase, _instruction, id, _ms, output) => { calls++; return reply(output, id, { coverage: [], baseline: [], preparationEvidence: [], unresolved: [] }); } });
    assert.equal(result.status, "incomplete"); assert.equal(calls, 1);
    if (result.status === "incomplete") assert.match(result.detail, /checks/);
  } finally { db.close(); }
});

test("invalid semantic coverage exhausts its durable allowance without resetting on resume", async () => {
  const { db, store } = storeFixture(); const initial = candidate(); let calls = 0;
  try {
    const deps: PreparationDependencies = { store, normalizeDraft, now: () => 1000, inputsCurrent: () => true,
      dispatch: async (_phase, _instruction, id, _ms, output) => { calls++; const draft = providerDraft(); draft.checks[0]!.requirementRefs = ["unknown"]; return reply(output, id, draft); } };
    const result = await prepareVerificationContract(initial, initial.requirements, deps);
    assert.equal(result.status, "incomplete"); assert.equal(calls, 2);
    if (result.status === "incomplete") assert.match(result.detail, /Invalid coverage|Unknown requirement on check/);
    const retry = await prepareVerificationContract(initial, initial.requirements, deps);
    assert.equal(retry.status, "incomplete"); assert.equal(calls, 2);
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
    const mapping = mapSnapshotWorkingDirectories(draft, snapshot);
    assert.deepEqual(mapping, { [snapshot]: ".", [inside]: "tests" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("provider snapshot paths normalize to stable host-owned locations", () => {
  const stale = "/private/var/folders/g1/tmp/rafi-qa-zI70FH";
  const text = `cwd=${stale} scratch=${stale}/scratch/red-phase.log`;
  assert.equal(normalizeSnapshotPaths(text), "cwd=. scratch=scratch/red-phase.log");
});
