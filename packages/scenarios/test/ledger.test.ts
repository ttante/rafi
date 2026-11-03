// The coverage ledger: all 121 scenarios registered with covers and milestone; every REQ ID covered or on
// SCN 10's not-testable list; the generated table matches SCN 10; the registry matches the docs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRegistry } from "../checks/import-docs.mjs";
import { ledger, readDoc, requirementIds } from "../checks/ledger.js";
import { registry } from "../checks/registry.js";

const req = readDoc("REWRITE_REQUIREMENTS.md");
const scn = readDoc("REWRITE_SCENARIOS.md");
const arch = readDoc("REWRITE_ARCHITECTURE.md");

test("the registry is current with SCN and ARCH 14 (rerun import-docs.mjs if not)", () => {
  const fresh = buildRegistry(scn, arch).map((e: { id: string; covers: string[]; milestone: string | null }) =>
    ({ id: e.id, covers: e.covers, milestone: e.milestone }));
  assert.deepEqual(registry.map((e) => ({ id: e.id, covers: [...e.covers], milestone: e.milestone })), fresh);
});

test("121 scenarios, each in exactly one milestone; M1 runs S-CLI-1 and S-CLI-2 in full", () => {
  assert.equal(registry.length, 121);
  assert.deepEqual(registry.filter((e) => !e.milestone).map((e) => e.id), []);
  assert.deepEqual(registry.filter((e) => e.milestone === "M1").map((e) => e.id), ["S-CLI-1", "S-CLI-2"]);
  assert.equal(registry.filter((e) => e.milestone !== "M1").length, 119);
});

test("every requirement is covered or not scenario-testable, and the table matches SCN 10", () => {
  assert.equal(requirementIds(req).length, 638);
  const report = ledger(registry, req, scn);
  assert.deepEqual(report.uncovered, []);
  assert.deepEqual(report.unknownCovers, []);
  assert.deepEqual(report.drift, []);
});
