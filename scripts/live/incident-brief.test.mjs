import test from "node:test";
import assert from "node:assert/strict";
import { LIVE_INCIDENT_BRIEF } from "./incident-brief.mjs";
test("live incident brief delegates baseline and scope comparison to Rafi", () => {
  assert.match(LIVE_INCIDENT_BRIEF, /Rafi performs host-owned baseline, unchanged-file, path-scope, and byte-identity comparisons/);
  assert.match(LIVE_INCIDENT_BRIEF, /QA must not reconstruct or compare preimplementation files/);
  assert.doesNotMatch(LIVE_INCIDENT_BRIEF, /retain the preimplementation source|cp .*preimpl|cmp .*baseline/i);
});
