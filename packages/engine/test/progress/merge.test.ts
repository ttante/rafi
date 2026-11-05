// M5 item 33 (C225; ARCH 3.7 `:414`, S-PORT-2): a `.rafi/progress.yaml` git left with conflict markers is split into
// ours and theirs, each validated, and merged per entry by the newer `at` (ties keep ours), with one line per
// conflicting ticket naming the side it kept. One invalid side keeps the valid side with one line; two invalid sides
// are damaged (the database wins). Two rafi-owned entries under one id with different identities are both kept,
// theirs under the next free FIX-<n>.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stringify } from "yaml";
import { hasMarkers, mergeConflicted } from "../../src/progress/merge.js";

const owned = (hint: string) => ({ source: "ci", requirements: ["suite/x.test"], hint, unit: null });
const body = (tickets: Record<string, unknown>, answers: Record<string, unknown> = {}) =>
  stringify({ version: 1, tickets, questions: {}, answers }, { sortMapEntries: true });

/** A conflicted file as git writes it: the shared lines, then ours and theirs between the markers. */
function conflicted(ours: string, theirs: string, base?: string): string {
  return `# Written by rafi\n<<<<<<< HEAD\n${ours}${base === undefined ? "" : `||||||| base\n${base}`}` +
    `=======\n${theirs}>>>>>>> other\n`;
}

test("the newer entry per ticket wins, ties keep ours; one line per conflicting ticket naming the side", () => {
  const ours = body({ T1: { status: "done", at: "2026-11-01T14:10:00Z" },
    T2: { status: "planned", at: "1970-01-01T00:00:00.000Z" },
    T3: { status: "planned", at: "1970-01-01T00:00:00.000Z" },
    T4: { status: "done", at: "2026-11-01T12:00:00Z" } });
  const theirs = body({ T1: { status: "planned", at: "1970-01-01T00:00:00.000Z" },
    T2: { status: "planned", at: "1970-01-01T00:00:00.000Z" },
    T3: { status: "done", at: "2026-11-01T13:58:00Z" },
    T4: { status: "blocked", at: "2026-11-01T12:00:00Z", reason: "tie" }, T5: { status: "done", at: "2026-11-01T11:00:00Z" } });
  const r = mergeConflicted(conflicted(ours, theirs), new Set());
  assert.ok("file" in r, JSON.stringify(r));
  assert.deepEqual(Object.fromEntries(Object.entries(r.file.tickets).map(([k, v]) => [k, v.status])),
    { T1: "done", T2: "planned", T3: "done", T4: "done", T5: "done" });
  assert.deepEqual(r.lines, ["T1: kept ours (14:10 vs 00:00)", "T3: kept theirs (13:58 vs 00:00)",
    "T4: kept ours (12:00 vs 12:00)"], "T2 is the same on both sides, T5 only on theirs: no line");
  assert.equal(hasMarkers(conflicted(ours, theirs)), true);
  assert.equal(hasMarkers(ours), false);
});

test("a diff3 base section is ignored; questions and answers merge by key, newer `at` first", () => {
  const ours = body({}, { "decision|T1|a": { at: "2026-11-01T10:00:00Z", choice: "EUR", source: "terminal" } });
  const theirs = body({}, { "decision|T1|a": { at: "2026-11-01T11:00:00Z", choice: "USD", source: "terminal" },
    "decision|T2|b": { at: "2026-11-01T09:00:00Z", choice: "yes", source: "terminal" } });
  const r = mergeConflicted(conflicted(ours, theirs, body({ T9: { status: "done", at: "2026-01-01T00:00:00Z" } })),
    new Set());
  assert.ok("file" in r);
  assert.equal(r.file.tickets.T9, undefined, "the base section isn't a side");
  assert.deepEqual(Object.fromEntries(Object.entries(r.file.answers).map(([k, v]) => [k, v.choice])),
    { "decision|T1|a": "USD", "decision|T2|b": "yes" });
});

test("one invalid side keeps the valid side with one line; two invalid sides are damaged", () => {
  const good = body({ T1: { status: "done", at: "2026-11-01T14:10:00Z" } });
  const bad = "version: 1\ntickets:\n  T1: { status: shipped, at: x }\nquestions: {}\nanswers: {}\n";
  const r = mergeConflicted(conflicted(bad, good), new Set());
  assert.ok("file" in r, JSON.stringify(r));
  assert.equal(r.file.tickets.T1?.status, "done");
  assert.equal(r.lines.length, 1, r.lines.join("\n"));
  assert.match(r.lines[0]!, /our side of the conflict isn't valid .*; kept theirs\./);
  const both = mergeConflicted(conflicted(bad, "version: 2\n"), new Set());
  assert.ok("invalid" in both, JSON.stringify(both));
  assert.ok("invalid" in mergeConflicted("version: 1\n<<<<<<< HEAD\nno end\n", new Set()), "an unclosed marker");
});

test("two different fix tickets under one id: both kept, theirs under the next free FIX-<n>; the same one merges",
  () => {
    const ours = body({ "FIX-1": { status: "done", at: "2026-11-01T14:00:00Z", owned: owned("T2") } });
    const theirs = body({ "FIX-1": { status: "planned", at: "2026-11-01T15:00:00Z",
      owned: { ...owned("T3"), requirements: ["suite/w.test"] } } });
    const r = mergeConflicted(conflicted(ours, theirs), new Set(["FIX-1", "FIX-2"]));
    assert.ok("file" in r);
    assert.deepEqual(Object.keys(r.file.tickets).sort(), ["FIX-1", "FIX-3"], "FIX-2 is taken on this computer");
    assert.equal(r.file.tickets["FIX-1"]?.owned?.hint, "T2");
    assert.equal(r.file.tickets["FIX-3"]?.owned?.hint, "T3");
    assert.deepEqual(r.lines, ["FIX-1: the other side has a different fix ticket with that id; kept it as FIX-3."]);
    const same = mergeConflicted(conflicted(ours, body({ "FIX-1": { status: "in_progress",
      at: "2026-11-01T15:00:00Z", step: "fixing·fix", fixes: 1, owned: owned("T2") } })), new Set());
    assert.ok("file" in same);
    assert.deepEqual([Object.keys(same.file.tickets), same.file.tickets["FIX-1"]?.status], [["FIX-1"], "in_progress"]);
  });
