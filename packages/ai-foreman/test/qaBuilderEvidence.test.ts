import test from "node:test";
import assert from "node:assert/strict";
import { hostTestSequenceEvidence } from "../src/qaBuilderEvidence.js";

const observation = (sourceDigest: string, outcome: string, startedAt: string, testPath = "test/subtract.test.mjs") => ({
  kind: "node-test" as const, startedAt, completedAt: startedAt, outcome, sourceDigest, testPath,
});

test("host test evidence requires a failed baseline run followed by a passing changed-source run", () => {
  const initial = "a".repeat(64), final = "b".repeat(64);
  const result = hostTestSequenceEvidence([
    { ...observation("c".repeat(64), "failed", "2026-10-18T23:34:00.000Z"), kind: "npm-test" },
    observation(final, "completed", "2026-10-18T23:34:02.000Z"),
  ], final, "test/subtract.test.mjs");
  assert.equal(result?.length, 2);
  assert.equal(result?.[0]?.outcome, "failed");
  assert.equal(result?.[1]?.outcome, "completed");
});

test("host test evidence does not infer historical order from a later passing run", () => {
  const initial = "a".repeat(64), final = "b".repeat(64);
  assert.equal(hostTestSequenceEvidence([observation(final, "completed", "2026-10-18T23:34:02.000Z")], final), undefined);
  assert.equal(hostTestSequenceEvidence([
    observation("c".repeat(64), "denied", "2026-10-18T23:34:00.000Z"),
    observation(final, "completed", "2026-10-18T23:34:02.000Z"),
  ], final), undefined);
});
