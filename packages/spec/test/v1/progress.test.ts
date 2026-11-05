// M5 P49 (ARCH 3.7 `:413`): a rafi-owned ticket's progress entry carries `owned` as its ticket.added recorded it;
// the file stays version 1 and strict; `progress.imported`'s entry may carry `fixes` and `owned`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { progressFile } from "../../src/v1/progress.js";
import { progressEntry } from "../../src/v1/events/history.js";

const owned = { source: "ci", requirements: ["suite/x.test"], hint: "T2", unit: null };
const file = (entry: unknown) => ({ version: 1, tickets: { "FIX-1": entry }, questions: {}, answers: {} });

test("an owned entry is accepted; an unknown field in it, or a bad source, isn't", () => {
  assert.ok(progressFile.safeParse(file({ status: "in_progress", at: "t", step: "fixing·fix", fixes: 1, owned }))
    .success);
  assert.ok(!progressFile.safeParse(file({ status: "done", at: "t", owned: { ...owned, extra: 1 } })).success);
  assert.ok(!progressFile.safeParse(file({ status: "done", at: "t", owned: { ...owned, source: "manual" } })).success);
});

test("progress.imported's entry may carry fixes and owned, and stays strict", () => {
  const at = "2026-11-01T13:00:00.000Z";
  assert.ok(progressEntry.safeParse({ kind: "ticket", key: "FIX-1", status: "in_progress", at, fixes: 1, owned })
    .success);
  assert.ok(!progressEntry.safeParse({ kind: "ticket", key: "FIX-1", status: "done", at, step: "x" }).success);
});
