// Item 11 (M3 plan): the what-next rows of answerEffects (C103): every option's events, the note and confirmation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkEventData } from "rafi-spec/v1";
import { whatNextEffects } from "../../src/state/answers.js";

const base = { ticket: "T1", findings: ["R4"], fp: "sha256:abc" };

test("Retry another Builder fix: fix.granted by you, then unblocked into the fix step", () => {
  const out = whatNextEffects({ ...base, choice: "retry", note: null });
  assert.ok(out.ok);
  assert.deepEqual(out.events.map((e) => [e.type, e.data]), [
    ["fix.granted", { by: "user", reason: "Retry another Builder fix" }],
    ["ticket.unblocked", { resume_step: "fix", by: "user" }],
  ]);
});

test("I verified it myself: a note is required (trimmed); the waiver names only the open findings", () => {
  for (const note of [null, "", "   \n"]) {
    const out = whatNextEffects({ ...base, choice: "verified", note });
    assert.equal(out.ok, false);
    assert.match(out.ok ? "" : out.reason, /note/i);
  }
  const out = whatNextEffects({ ...base, choice: "verified", note: "Checked the empty state on a phone" });
  assert.ok(out.ok);
  assert.deepEqual(out.events.map((e) => [e.type, e.data]), [
    ["waiver.recorded", { kind: "verified-myself", note: "Checked the empty state on a phone", findings: ["R4"],
      fp: "sha256:abc" }],
    ["ticket.unblocked", { resume_step: "deliver", by: "user" }],
  ]);
});

test("Explicitly waive QA: only after PRM-82's confirmation; the waiver keeps the unresolved findings", () => {
  const unconfirmed = whatNextEffects({ ...base, choice: "waive", note: null });
  assert.equal(unconfirmed.ok, false);
  const out = whatNextEffects({ ...base, choice: "waive", note: null, confirmed: true });
  assert.ok(out.ok);
  assert.deepEqual(out.events.map((e) => [e.type, e.data]), [
    ["waiver.recorded", { kind: "waive-qa", note: "", findings: ["R4"], fp: "sha256:abc" }],
    ["ticket.unblocked", { resume_step: "deliver", by: "user" }],
  ]);
});

test("the Planner and Pause options aren't built yet and change nothing; an unknown choice is refused", () => {
  for (const [choice, milestone] of [["planner", "M8"], ["pause", "M4"]] as const) {
    const out = whatNextEffects({ ...base, choice, note: null });
    assert.equal(out.ok, false);
    assert.match(out.ok ? "" : out.reason, new RegExp(`isn't in the new engine yet \\(milestone ${milestone}\\)`));
  }
  assert.equal(whatNextEffects({ ...base, choice: "nonsense", note: null }).ok, false);
});

test("every effect validates against its event schema", () => {
  for (const choice of ["retry", "verified", "waive"]) {
    const out = whatNextEffects({ ...base, choice, note: "n", confirmed: true });
    assert.ok(out.ok);
    for (const e of out.events) assert.ok(checkEventData(e.type, 1, e.data).ok, e.type);
  }
});
