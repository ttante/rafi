import assert from "node:assert/strict";
import { test } from "node:test";
import { qaHostTransformation, verifyQaHostTransformation } from "../src/qaHostTransformation.js";
const provenance = { operation: "qa-preparation-assessment", tupleDigest: "a".repeat(64) };

test("QA host identity effects are replayable and cannot alter requirement judgments", () => {
  const before = { concerns: [{ material: true, requirementIds: ["r1"] }], assessedRequirementIds: ["r1"] };
  const after = { ...before, sessionId: "prepared", operationId: "sealed" };
  const record = qaHostTransformation({ ...provenance, rule: "assessment-host-bindings-v1", before, after });
  assert.equal(record.effects.length, 2);
  verifyQaHostTransformation(record, before, after);
  assert.throws(() => verifyQaHostTransformation({ ...record, outputDigest: "b".repeat(64) }, before, after), /replay mismatch/);
  assert.throws(() => qaHostTransformation({ ...provenance, rule: "assessment-host-bindings-v1", before,
    after: { ...after, concerns: [{ material: false, requirementIds: ["r1"] }] } }), /cannot change/);
});

test("depth bookkeeping derives exact labels without changing risk or depth", () => {
  const before = { level: 4, minimumReasons: [], riskFactors: [{ category: "migration" }] };
  const after = { ...before, minimumReasons: ["migration"], plannerIdentity: "session", plannerOperationId: "dispatch" };
  const record = qaHostTransformation({ ...provenance, rule: "depth-host-bindings-v1", before, after });
  verifyQaHostTransformation(record, before, after);
  assert.throws(() => qaHostTransformation({ ...provenance, rule: "depth-host-bindings-v1", before, after: { ...after, minimumReasons: ["invented"] } }), /exactly derivable/);
  assert.throws(() => qaHostTransformation({ ...provenance, rule: "depth-host-bindings-v1", before, after: { ...after, level: 1 } }), /cannot change/);
});


test("draft provenance rejects removed requirements, waived checks and changed verification", () => {
  const before = { requirements: [{ id: "r1", obligation: "mandatory" }], checks: [{ id: "check-provider", obligation: "mandatory", requirementRefs: ["r1"],
    verification: [{ cwd: "/snapshot", steps: ["run the required test"] }], dependsOnChecks: [], prerequisiteRefs: [] }], coverage: [{ requirementId: "r1", checkIds: ["check-provider"] }], baseline: [], preparationEvidence: [], unresolved: [] };
  const after = structuredClone(before);
  after.checks[0].id = "check-host"; after.coverage[0].checkIds = ["check-host"]; after.checks[0].verification[0].cwd = ".";
  const args = { ...provenance, rule: "draft-host-bindings-v1" as const, before, workspacePaths: { "/snapshot": "." } };
  const record = qaHostTransformation({ ...args, after });
  verifyQaHostTransformation(record, before, after, args.workspacePaths);
  for (const mutate of [(copy: typeof after) => { copy.requirements = []; },
    (copy: typeof after) => { copy.checks[0].obligation = "advisory"; },
    (copy: typeof after) => { copy.checks[0].verification[0].steps = ["skip the test"]; }]) {
    const changed = structuredClone(after); mutate(changed);
    assert.throws(() => qaHostTransformation({ ...args, after: changed }), /cannot change/);
  }
});
