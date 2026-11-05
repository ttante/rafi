// M5 plan item 27 (ARCH 7.10 :1148, C191): which ticket fields are material for the scope key. Acceptance (and its
// person-only and locked marks), required tests, dependencies, likely files, tags, order and the set of tickets are;
// title and summary (rewording) aren't; the plan revision is part of the key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeFingerprint, scopeKey } from "../../src/plan/approval.js";

const T = { id: "T1", order: 1, title: "A", summary: "A", acceptance: ["works"], person_only: [], locked: [],
  required_tests: ["npm test"], depends_on: [], likely_files: ["src/a.ts"], tags: ["backend"] };

test("each material field changes the key; rewording doesn't; the revision is in it", () => {
  const base = scopeKey(1, [T]);
  assert.match(base, /^scope\|1\|sha256:[0-9a-f]{64}$/);
  for (const [field, value] of [["acceptance", ["works", "and logs"]], ["person_only", [1]], ["locked", [1]],
    ["required_tests", ["npm run e2e"]], ["depends_on", ["T0"]], ["likely_files", ["src/b.ts"]], ["tags", ["ui"]],
    ["order", 2]] as const) {
    assert.notEqual(scopeKey(1, [{ ...T, [field]: value }]), base, field);
  }
  assert.equal(scopeKey(1, [{ ...T, title: "B", summary: "B" } as typeof T]), base, "rewording only");
  assert.equal(scopeKey(1, [{ ...T, tags: ["backend"], likely_files: ["src/a.ts"] }]), base);
  assert.notEqual(scopeKey(1, [T, { ...T, id: "T2" }]), base, "a ticket added");
  assert.notEqual(scopeKey(2, [T]), base, "a new plan revision");
  assert.match(scopeFingerprint(base), /^sha256:[0-9a-f]{64}$/);
});
