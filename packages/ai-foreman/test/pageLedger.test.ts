import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { canonicalJson } from "rafi-spec";
import { WorkflowDb } from "../src/workflowDb.js";

function page(tickets: unknown[]) { return canonicalJson({ tickets }); }
function pageDigest(content: string) { return createHash("sha256").update(content).digest("hex"); }

test("page ledger accepts only canonical, ordered, bounded ticket pages", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-page-ledger-"));
  const tupleDigest = "a".repeat(64);
  try {
    const db = new WorkflowDb(dir);
    try {
      db.beginPageLedger({ artifactId: "artifact", runId: "run", lineageId: "lineage", tupleDigest, leaseId: "lease" });
      const first = page([{ id: "one" }]);
      const appended = db.appendPageLedger({ artifactId: "artifact", lineageId: "lineage", tupleDigest, leaseId: "lease", ordinal: 0, predecessorDigest: null, content: first, terminal: false });
      assert.equal(appended.digest, pageDigest(first));
      assert.equal(db.appendPageLedger({ artifactId: "artifact", lineageId: "lineage", tupleDigest, leaseId: "lease", ordinal: 0, predecessorDigest: null, content: first, terminal: false }).duplicate, true);
      const last = page([]);
      db.appendPageLedger({ artifactId: "artifact", lineageId: "lineage", tupleDigest, leaseId: "lease", ordinal: 1, predecessorDigest: appended.digest, content: last, terminal: true });
      assert.throws(() => db.appendPageLedger({ artifactId: "artifact", lineageId: "lineage", tupleDigest, leaseId: "lease", ordinal: 2, predecessorDigest: pageDigest(last), content: last, terminal: true }), /after terminal/);
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("page ledger rejects non-canonical and oversized ticket collections before persistence", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-page-ledger-"));
  const tupleDigest = "b".repeat(64);
  try {
    const db = new WorkflowDb(dir);
    try {
      db.beginPageLedger({ artifactId: "artifact", runId: "run", lineageId: "lineage", tupleDigest, leaseId: "lease" });
      assert.throws(() => db.appendPageLedger({ artifactId: "artifact", lineageId: "lineage", tupleDigest, leaseId: "lease", ordinal: 0, predecessorDigest: null, content: '{"tickets": []}', terminal: true }), /canonical JSON/);
      assert.throws(() => db.appendPageLedger({ artifactId: "artifact", lineageId: "lineage", tupleDigest, leaseId: "lease", ordinal: 0, predecessorDigest: null, content: page(Array.from({ length: 151 }, (_, index) => ({ id: index }))), terminal: true }), /150-ticket/);
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("page ledger enforces exact byte/page/aggregate limits and immutable duplicate metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-page-boundaries-"));
  const db = new WorkflowDb(root), tupleDigest = "c".repeat(64);
  const begin = (artifactId: string) => db.beginPageLedger({ artifactId, runId: "run", lineageId: artifactId, tupleDigest, leaseId: "lease" });
  const append = (artifactId: string, ordinal: number, content: string, predecessorDigest: string | null, terminal = false) =>
    db.appendPageLedger({ artifactId, lineageId: artifactId, tupleDigest, leaseId: "lease", ordinal, content, predecessorDigest, terminal });
  const sized = (bytes: number) => { const base = canonicalJson({ tickets: [], padding: "" });
    return canonicalJson({ tickets: [], padding: "x".repeat(bytes - Buffer.byteLength(base)) }); };
  try {
    begin("bytes");
    const limit = sized(750 * 1024);
    assert.equal(Buffer.byteLength(limit), 750 * 1024);
    const first = append("bytes", 0, limit, null);
    assert.throws(() => append("bytes", 1, sized(750 * 1024 + 1), first.digest), /750 KiB/);
    assert.throws(() => append("bytes", 0, limit, null, true), /Conflicting duplicate/);
    assert.throws(() => append("bytes", 1, page([]), "d".repeat(64)), /predecessor/);
    assert.throws(() => append("bytes", 2, page([]), first.digest), /out of order/);
    begin("tickets"); const terminalTickets = page(Array.from({ length: 150 }, (_, id) => ({ id })));
    append("tickets", 0, terminalTickets, null, true);
    assert.throws(() => append("tickets", 0, terminalTickets, null, true), /Duplicate terminal/);
    begin("pages"); let predecessor: string | null = null;
    for (let ordinal = 0; ordinal < 60; ordinal++) predecessor = append("pages", ordinal, page([]), predecessor).digest;
    assert.throws(() => append("pages", 60, page([]), predecessor), /60-page/);
    begin("aggregate"); predecessor = null;
    for (let ordinal = 0; ordinal < 8; ordinal++) predecessor = append("aggregate", ordinal, limit, predecessor).digest;
    const remainder = sized(6 * 1024 * 1024 - 8 * 750 * 1024);
    predecessor = append("aggregate", 8, remainder, predecessor).digest;
    assert.throws(() => append("aggregate", 9, page([]), predecessor), /6 MiB/);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
