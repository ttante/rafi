import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_GRAPH_CONFIG } from "rafi-spec";
import { adoptGraph, disableGraph, refreshGraph } from "../src/graph/maintenance.js";
import { resolveGraphPython } from "../src/graph/bridge.js";
import { withGraphDerivedAccess } from "../src/graph/derived.js";
import { loadGraphConfig } from "../src/graph/config.js";
import { graphExclusions } from "../src/graph/corpus.js";
import { digest } from "../src/graph/util.js";
import { sendPreparationGraphTurn } from "../src/graph/preparation.js";
import { WorkflowReader } from "../src/workflowReader.js";
import { WorkflowDb } from "../src/workflowDb.js";
import type { BuilderAdapter } from "../src/adapters/types.js";

for (const phase of ["planner", "prepare", "assess", "challenge", "repair"] as const) {
  test(`preparation ${phase} retains phase, operation and independent session through graph exchange`, async () => {
    const root = mkdtempSync(join(tmpdir(), "graph-preparation-"));
    try {
      writeFileSync(join(root, "main.py"), "def main(): pass\n");
      adoptGraph(root, { authorization: "explicit", config: { ...structuredClone(DEFAULT_GRAPH_CONFIG), mode: "code-only" } });
      let calls = 0;
      const adapter: BuilderAdapter = { agent: "claude", sessionId: () => `${phase}-independent`, events: async function* () {}, close: async () => {},
        sendTurn: async (text, policy) => {
          calls++;
          assert.equal(policy?.purpose, phase === "planner" ? "planning" : phase === "repair" ? "response-repair" : "preparation");
          assert.equal(policy?.responseOnly, phase === "repair");
          if (phase === "repair") assert.equal(text, "complete mandatory inventory");
          else {
            assert.equal(policy?.logicalActionId, "reserved-operation");
            assert.match(text, calls === 1 ? /complete mandatory inventory/ : /Continue the same frozen action/);
            assert.match(text, /rafi_graph_evidence/);
          }
          return { text: calls === 1 && phase !== "repair" ? JSON.stringify({ kind: "rafi_graph_request", version: 1, requestId: "navigation", operations: [{ operation: "query", query: "main" }] }) : "normal phase result",
            isError: false, numTurns: 1, costUsd: 0.1, costAuthoritative: true, usage: { scope: "turn-delta", inputTokens: 10, outputTokens: 5 } };
        } };
      const result = await sendPreparationGraphTurn(adapter, "complete mandatory inventory", { phase, projectDir: root, workspace: root, sourceRef: "frozen-source", runId: "run", workId: "work", operationId: "reserved-operation", remainingMs: 5000 });
      assert.equal(result.text, "normal phase result");
      assert.equal(calls, phase === "repair" ? 1 : 2);
      assert.equal(result.graphReceiptRefs.length, phase === "repair" ? 0 : 2);
      assert.equal(result.costUsd, calls * 0.1);
      const db = new WorkflowDb(root);
      try {
        const receipt = db.graphStore().get<{ purpose: string; sessionRef: string }>("receipt", "reserved-operation:1")?.value;
        if (phase === "repair") assert.equal(receipt, undefined);
        else {
          assert.equal(receipt?.purpose, phase === "planner" ? "planning" : phase === "assess" ? "preparation-assessment" : phase === "challenge" ? "preparation-challenge" : "qa-preparation");
          assert.equal(receipt?.sessionRef, `${phase}-independent`);
        }
      } finally { db.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("expired preparation cannot send a graph continuation after a late provider return", async () => {
  const root = mkdtempSync(join(tmpdir(), "graph-preparation-timeout-"));
  try {
    adoptGraph(root, { authorization: "explicit", config: { ...structuredClone(DEFAULT_GRAPH_CONFIG), mode: "code-only" } });
    let calls = 0, closes = 0;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const adapter: BuilderAdapter = { agent: "claude", sessionId: () => "deadline-session", events: async function* () {}, close: async () => { closes++; }, sendTurn: async () => {
      calls++; await pending;
      return { text: JSON.stringify({ kind: "rafi_graph_request", version: 1, requestId: "late", operations: [{ operation: "query", query: "main" }] }), isError: false, numTurns: 1, costUsd: 0 };
    } };
    await assert.rejects(sendPreparationGraphTurn(adapter, "inventory", { phase: "challenge", projectDir: root, workspace: root, sourceRef: "snapshot", runId: "run", workId: "work", operationId: "timeout", remainingMs: 1000 }), /deadline exceeded/);
    release();
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(calls, 1); assert.equal(closes, 1);
    const db = new WorkflowDb(root);
    try { assert.equal(db.graphStore().get<{ state: string }>("exchange", "timeout")?.value.state, "uncertain"); }
    finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preparation artifacts and events retain graph provenance and refuse revoked redisclosure", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-preparation-provenance-"));
  try {
    adoptGraph(root, { authorization: "explicit", config: { ...structuredClone(DEFAULT_GRAPH_CONFIG), mode: "code-only" } });
    const config = loadGraphConfig(root);
    const grant = { policyDigest: config.policyDigest, workspace: root, exclusionsDigest: digest("exclusions", graphExclusions(root).text), sourceVersions: {}, paths: [] };
    const db = new WorkflowDb(root);
    try {
      db.ensureRun("run");
      db.admitWork({ runId: "run", kind: "ticket", ticketId: "work", definition: { id: "work", title: "Inspect source" }, approvalId: "fixture", scopeRevision: "fixture", provenance: { userTurn: "Inspect source", reason: "Explicit fixture" } });
      const store = db.qaPreparationStore();
      const id = withGraphDerivedAccess([grant], () => {
        store.event("run", "work", "derived-event", "preparation-provider-return", { text: "private relationship" });
        return store.putArtifact("investigation-evidence", { text: "private relationship" });
      });
      assert.deepEqual(store.artifact(id, "investigation-evidence"), { text: "private relationship" });
      withGraphDerivedAccess([], () => {
        store.artifact(id, "investigation-evidence");
        store.putArtifact("derived-draft", { analysis: "transformed relationship" });
      });
      disableGraph(root);
      assert.throws(() => store.artifact(id, "investigation-evidence"), /revoked graph-derived/);
      assert.throws(() => store.eventRecord("derived-event"), /revoked graph-derived/);
      const reader = new WorkflowReader(root);
      try {
        const events = reader.qaPreparationEvents("run");
        assert.equal(events[0]?.kind, "evidence-unavailable");
        assert.ok(!JSON.stringify(events).includes("private relationship"));
        assert.equal(reader.qaPreparationMetrics("run").withheldEvents, 1);
      } finally { reader.close(); }
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preparation uses a populated equivalent snapshot graph and falls back after source drift", async t => {
  let python: string;
  try { python = await resolveGraphPython(); } catch (error) { t.skip(String(error)); return; }
  const root = mkdtempSync(join(tmpdir(), "graph-preparation-root-"));
  const snapshot = mkdtempSync(join(tmpdir(), "graph-preparation-snapshot-"));
  try {
    const source = "def helper(): return 1\ndef caller(): return helper()\n";
    for (const directory of [root, snapshot]) writeFileSync(join(directory, "main.py"), source);
    adoptGraph(root, { authorization: "explicit", config: { ...structuredClone(DEFAULT_GRAPH_CONFIG), mode: "code-only", include: ["main.py"] } });
    if (existsSync(join(root, ".gitignore"))) copyFileSync(join(root, ".gitignore"), join(snapshot, ".gitignore"));
    const built = await refreshGraph(root, root, "fixture-build", { python });
    assert.equal(built.state, "published", built.reason);
    const prompts: string[] = [];
    const adapter: BuilderAdapter = { agent: "claude", sessionId: () => `snapshot-${prompts.length}`, events: async function* () {}, close: async () => {}, sendTurn: async text => {
      prompts.push(text); return { text: "source-verified candidate", isError: false, numTurns: 1, costUsd: 0 };
    } };
    await sendPreparationGraphTurn(adapter, "Inspect caller helper dependencies", { phase: "prepare", projectDir: root, workspace: snapshot, sourceRef: "frozen", runId: "run", workId: "work", operationId: "matching", remainingMs: 10000 });
    const db = new WorkflowDb(root);
    try {
      assert.equal(db.graphStore().get<{ decision: string }>("receipt", "matching:0")?.value.decision, "used");
      assert.match(prompts[0], /helper/);
      writeFileSync(join(snapshot, "main.py"), "def changed(): return 2\n");
      await sendPreparationGraphTurn(adapter, "Inspect changed dependencies", { phase: "assess", projectDir: root, workspace: snapshot, sourceRef: "changed", runId: "run", workId: "work", operationId: "drifted", remainingMs: 10000 });
      assert.equal(db.graphStore().get<{ decision: string }>("receipt", "drifted:0")?.value.decision, "unavailable");
      assert.match(prompts[1], /unavailable/);
      assert.equal(db.graphStore().list("generation").length, 1, "Preparation never starts extraction");
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(snapshot, { recursive: true, force: true }); }
});
