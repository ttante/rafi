import test from "node:test";
import assert from "node:assert/strict";
import { hostTestSequenceEvidence, retainedHostBuilderObservations } from "../src/qaBuilderEvidence.js";

const observation = (sourceDigest: string, outcome: string, startedAt: string, testPath = "test/subtract.test.mjs", sequence = 0) => ({
  kind: "node-test" as const, sequence, startedAt, completedAt: startedAt, outcome, sourceDigest, testPath,
});

test("host test evidence requires a failed baseline run followed by a passing changed-source run", () => {
  const initial = "a".repeat(64), final = "b".repeat(64);
  const result = hostTestSequenceEvidence([
    { ...observation("c".repeat(64), "failed", "2026-10-18T23:34:00.000Z"), kind: "npm-test" },
    observation(final, "completed", "2026-10-18T23:34:02.000Z", "test/subtract.test.mjs", 1),
  ], final, "test/subtract.test.mjs");
  assert.equal(result?.length, 2);
  assert.equal(result?.[0]?.outcome, "failed");
  assert.equal(result?.[1]?.outcome, "completed");
});

test("host test evidence requires the failed run to use the captured pre-edit source when one is supplied", () => {
  const initial = "a".repeat(64), final = "b".repeat(64);
  assert.equal(hostTestSequenceEvidence([
    observation("c".repeat(64), "failed", "2026-10-18T23:34:00.000Z", "test/subtract.test.mjs", 0),
    observation(final, "completed", "2026-10-18T23:34:02.000Z", "test/subtract.test.mjs", 1),
  ], final, "test/subtract.test.mjs", initial), undefined);
  assert.equal(hostTestSequenceEvidence([
    observation(initial, "failed", "2026-10-18T23:34:00.000Z", "test/subtract.test.mjs", 0),
    observation(final, "completed", "2026-10-18T23:34:02.000Z", "test/subtract.test.mjs", 1),
  ], final, "test/subtract.test.mjs", initial)?.length, 2);
});

test("host test evidence does not infer historical order from a later passing run", () => {
  const initial = "a".repeat(64), final = "b".repeat(64);
  assert.equal(hostTestSequenceEvidence([observation(final, "completed", "2026-10-18T23:34:02.000Z")], final), undefined);
  assert.equal(hostTestSequenceEvidence([
    observation("c".repeat(64), "denied", "2026-10-18T23:34:00.000Z", "test/subtract.test.mjs", 0),
    observation(final, "completed", "2026-10-18T23:34:02.000Z", "test/subtract.test.mjs", 1),
  ], final), undefined);
});

test("host Builder observations are recoverable from the coverage operation", () => {
  const retained = observation("a".repeat(64), "failed", "2026-10-18T23:34:00.000Z");
  const bytes = Buffer.from(JSON.stringify({ version: 1, kind: "host-builder-tool-observations", observations: [retained] }));
  const result = retainedHostBuilderObservations({
    operations: () => [{ kind: "builder-coverage", status: "confirmed", intent: { workId: "T1" }, result: { hostObservationDigest: "obs" } }],
    getEvidence: digest => digest === "obs" ? bytes : undefined,
  }, "run", "T1");
  assert.deepEqual(result, [retained]);
});
