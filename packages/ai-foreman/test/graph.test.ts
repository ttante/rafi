import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { assertGraphConfig, assertGraphReadRequest, DEFAULT_GRAPH_CONFIG } from "rafi-spec";
import { adoptGraph, disableGraph, refreshGraph } from "../src/graph/maintenance.js";
import { loadGraphConfig } from "../src/graph/config.js";
import { captureGraphCorpus } from "../src/graph/corpus.js";
import { graphStatus, acquireGraphView, readGraph } from "../src/graph/read.js";
import { resolveGraphPython, runBridge } from "../src/graph/bridge.js";
import { WorkflowDb } from "../src/workflowDb.js";
import { graphContext, sendGraphTurn } from "../src/graph/turn.js";
import type { BuilderAdapter } from "../src/adapters/types.js";
function project(): string {
  const root = mkdtempSync(join(tmpdir(), "rafi graph fixture "));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "main.py"), "def helper():\n    return 1\n\ndef caller():\n    return helper()\n");
  return root;
}
function config() { return { ...structuredClone(DEFAULT_GRAPH_CONFIG), mode: "code-only" as const, include: ["src/**"] }; }
test("graph protocols reject unknown authority, paths and invalid operation shapes", () => {
  assert.throws(() => assertGraphConfig({ ...config(), include: ["../private/**"] }));
  assert.throws(() => assertGraphReadRequest({ kind: "rafi_graph_request", version: 1, requestId: "r", operations: [{ operation: "query", query: "x", root: "/tmp" }] }));
  assert.throws(() => assertGraphReadRequest({ kind: "rafi_graph_request", version: 1, requestId: "r", operations: [{ operation: "path", seeds: ["a"] }] }));
  assertGraphReadRequest({ kind: "rafi_graph_request", version: 1, requestId: "r", operations: [{ operation: "query", query: "caller" }] });
});
test("unadopted status has no database or file creation", () => {
  const root = project();
  try {
    const before = readdirSync(root);
    assert.equal(graphStatus(root).enabled, false);
    assert.deepEqual(readdirSync(root), before);
  }
  finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("adoption is explicit and disabled policy remains authoritative", () => {
  const root = project();
  try {
    const accepted = adoptGraph(root, { config: config(), authorization: "explicit" });
    assert.equal(loadGraphConfig(root).enabled, true);
    assert.equal(adoptGraph(root, { config: config(), authorization: "explicit" }).initialOperationId, accepted.initialOperationId);
    disableGraph(root);
    assert.equal(loadGraphConfig(root).enabled, false);
  }
  finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("capture includes dirty/untracked bytes, excludes secrets, and preserves portable identity", () => {
  const root = project();
  try {
    adoptGraph(root, { config: config(), authorization: "explicit" });
    const effective = loadGraphConfig(root), initial = captureGraphCorpus(root, root, effective);
    writeFileSync(join(root, "src", ".env"), "SECRET=hidden");
    assert.equal(captureGraphCorpus(root, root, effective).corpusDigest, initial.corpusDigest);
    writeFileSync(join(root, "src", "main.py"), "def changed():\n    return 2\n");
    assert.notEqual(captureGraphCorpus(root, root, effective).corpusDigest, initial.corpusDigest);
    writeFileSync(join(root, ".graphifyignore"), "src/main.py\n");
    assert.equal(captureGraphCorpus(root, root, effective).inputs.length, 0);
  }
  finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("publication fencing prevents a second same-task owner and an expired owner", () => {
  const root = project();
  const db = new WorkflowDb(root);
  try {
    const store = db.graphStore();
    const fence = store.lease("s", "job", 100, 10);
    assert.throws(() => store.lease("s", "job", 101, 10));
    const successor = store.lease("s", "other", 111, 10);
    assert.equal(successor, fence + 1);
    assert.throws(() => store.publish("s", "job", fence, 112, 0, { id: "x" }, {}));
    assert.equal(store.get("head", "s"), undefined);
  }
  finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("host graph requests preserve one logical action and refuse uncertain replay", async () => {
  const root = project();
  try {
    adoptGraph(root, { config: config(), authorization: "explicit" });
    const prompts: string[] = [];
    const actions: string[] = [];
    const adapter = {
      agent: "codex", sessionId: () => "session", sendTurn: async (text: string, policy?: {
        logicalActionId?: string;
      }) => {
        prompts.push(text);
        actions.push(policy?.logicalActionId ?? "");
        return { text: prompts.length === 1 ? JSON.stringify({ kind: "rafi_graph_request", version: 1, requestId: "r1", operations: [{ operation: "query", query: "helper" }] }) : 'STEP_STATUS: done | summary="verified source"', isError: false, numTurns: 1, costUsd: 0, turnId: `turn-${prompts.length}` };
      }
    } as unknown as BuilderAdapter;
    const context = graphContext(root, root, "implementation", "Implement admitted work", { operationId: "exchange", logicalTaskId: "assignment" });
    const result = await sendGraphTurn(adapter, "Implement admitted work", context);
    assert.match(result.text, /STEP_STATUS: done/);
    assert.deepEqual(actions, ["assignment", "assignment"]);
    assert.match(prompts[1], /missing-graph/);
    await assert.rejects(sendGraphTurn(adapter, "Implement admitted work", context), /cannot be replayed/);
    assert.equal(prompts.length, 2);
    const readonlyContext = graphContext(root, root, "final-qa", "repair", { operationId: "repair" });
    await sendGraphTurn(adapter, "Protocol repair only", readonlyContext, { responseOnly: true });
    assert.equal(prompts[2], "Protocol repair only");
  }
  finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("mixed extraction without authorized semantic host preserves prior head", async () => {
  const root = project();
  try {
    writeFileSync(join(root, "src", "requirements.md"), "# Requirement\nMust preserve callers.");
    adoptGraph(root, { config: { ...config(), mode: "mixed" }, authorization: "explicit" });
    const result = await refreshGraph(root, root, "task");
    assert.equal(result.state, "failed");
    assert.match(result.reason!, /semantic-runtime-unavailable/);
    assert.equal(graphStatus(root).generation, undefined);
  }
  finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("certified bridge preserves direction and refuses incompatible schemas without writes", async (t) => {
  let python: string;
  try {
    python = await resolveGraphPython();
  }
  catch (error) {
    t.skip(String(error));
    return;
  }
  const root = project();
  try {
    const graph = { directed: true, multigraph: false, graph: { schema_version: 1 }, nodes: [{ id: "a", label: "caller", source_file: "src/main.py" }, { id: "b", label: "helper", source_file: "src/main.py" }], links: [{ source: "b", target: "a", _src: "a", _tgt: "b", relation: "calls", confidence: "EXTRACTED" }] };
    const before = readdirSync(root);
    const result = await runBridge<{
      nodes: Array<{
        id: string;
      }>;
    }>(python, { action: "read", graph, operation: { operation: "neighbors", seeds: ["a"], direction: "outgoing", depth: 1 } }, { cwd: root });
    assert.deepEqual(new Set(result.nodes.map(n => n.id)), new Set(["a", "b"]));
    await assert.rejects(runBridge(python, { action: "read", graph: { ...graph, graph: { schema_version: 999 } }, operation: { operation: "status" } }, { cwd: root }), /incompatible/);
    assert.deepEqual(readdirSync(root), before);
  }
  finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("AST publication, read, idempotent recovery and revocation use real Graphify", async (t) => {
  let python: string;
  try {
    python = await resolveGraphPython();
  }
  catch (error) {
    t.skip(String(error));
    return;
  }
  const root = project();
  try {
    adoptGraph(root, { config: config(), authorization: "explicit" });
    const result = await refreshGraph(root, root, "task-1", { python });
    assert.equal(result.state, "published", result.reason);
    assert.deepEqual(await refreshGraph(root, root, "task-1", { python }), result);
    const captured = captureGraphCorpus(root, root, loadGraphConfig(root));
    const view = acquireGraphView(root, root, captured);
    assert.ok("graph" in view);
    const resultRead = await readGraph(view, { operation: "query", query: "caller" });
    assert.equal(resultRead.freshness, "matching");
    assert.ok(resultRead.nodes.length, resultRead.limitations.map(x => x.detail).join("\n"));
    const manifest = join(root, "graphify-out", "rafi", "generations", result.generationId!, "manifest.json");
    const before = readFileSync(manifest, "utf8");
    await readGraph(view, { operation: "node", seeds: [resultRead.nodes[0].id] });
    assert.equal(readFileSync(manifest, "utf8"), before);
    writeFileSync(join(root, ".graphifyignore"), "src/main.py\n");
    const revoked = acquireGraphView(root, root);
    assert.ok("status" in revoked);
    assert.equal(revoked.status, "unavailable");
  }
  finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("equivalent frozen workspace reuses portable generation with a distinct source binding", async (t) => {
  let python: string;
  try {
    python = await resolveGraphPython();
  }
  catch (error) {
    t.skip(String(error));
    return;
  }
  const root = project(), snapshot = project();
  try {
    adoptGraph(root, { config: config(), authorization: "explicit" });
    const outcome = await refreshGraph(root, root, "base", { python });
    assert.equal(outcome.state, "published", outcome.reason);
    writeFileSync(join(snapshot, ".gitignore"), readFileSync(join(root, ".gitignore")));
    const capture = captureGraphCorpus(snapshot, root, loadGraphConfig(root), "frozen-qa");
    const view = acquireGraphView(root, snapshot, capture);
    assert.ok("graph" in view);
    assert.notEqual(view.generation.binding.workspaceRef, capture.binding.workspaceRef);
    const evidence = await readGraph(view, { operation: "query", query: "helper" });
    assert.equal(evidence.freshness, "matching");
    assert.equal(evidence.sourceBinding?.sourceRef, "frozen-qa");
  }
  finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(snapshot, { recursive: true, force: true });
  }
});
test("mixed refresh retains unchanged semantics and rejects omitted changed inputs", async (t) => {
  let python: string;
  try {
    python = await resolveGraphPython();
  }
  catch (error) {
    t.skip(String(error));
    return;
  }
  const root = project();
  try {
    writeFileSync(join(root, "src", "requirements.md"), "A caller must invoke helper.");
    adoptGraph(root, { config: { ...config(), mode: "mixed" }, authorization: "explicit" });
    let calls = 0;
    const host: import("../src/graph/maintenance.js").GraphSemanticHost = async (chunks, operationId) => { calls++; return { nodes: chunks.map(c => ({ id: `semantic:${c.path}`, label: c.text, source_file: c.path })), edges: [], origin: { provider: "fixture", operationId } }; };
    const first = await refreshGraph(root, root, "mixed-1", { python, semanticHost: host });
    assert.equal(first.state, "published", first.reason);
    writeFileSync(join(root, "src", "main.py"), "def caller():\n    return 2\n");
    const next = await refreshGraph(root, root, "mixed-2", { python, semanticHost: host });
    assert.equal(next.state, "published", next.reason);
    assert.equal(calls, 1);
    writeFileSync(join(root, "src", "requirements.md"), "Changed requirement.");
    const failed = await refreshGraph(root, root, "mixed-3", { python, semanticHost: async (_c, operationId) => ({ nodes: [], edges: [], origin: { provider: "fixture", operationId } }) });
    assert.equal(failed.state, "failed");
    assert.equal(graphStatus(root).generation?.id, next.generationId);
  }
  finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("derived evidence is withheld after revocation without rewriting its bytes", async (t) => {
  let python: string;
  try {
    python = await resolveGraphPython();
  }
  catch (error) {
    t.skip(String(error));
    return;
  }
  const root = project();
  try {
    adoptGraph(root, { config: config(), authorization: "explicit" });
    await refreshGraph(root, root, "base", { python });
    let callbackEvidence = "";
    const adapter = { agent: "codex", sessionId: () => "fixture", sendTurn: async () => {
      await Promise.resolve();
      const callbackDb = new WorkflowDb(root);
      try { callbackEvidence = callbackDb.putEvidence("qa", Buffer.from("provider event stream containing derived observations")); }
      finally { callbackDb.close(); }
      return { text: "source-backed conclusion", isError: false, numTurns: 1, costUsd: 0, turnId: "turn" };
    } } as unknown as BuilderAdapter;
    await sendGraphTurn(adapter, "Investigate dependencies", graphContext(root, root, "planning", "helper"));
    const db = new WorkflowDb(root);
    let id: string;
    try {
      id = db.putEvidence("qa", Buffer.from("source-backed conclusion"));
      assert.ok(db.getEvidence(id));
    }
    finally {
      db.close();
    }
    disableGraph(root);
    const denied = new WorkflowDb(root);
    try {
      assert.equal(denied.getEvidence(id!), undefined);
      assert.equal(denied.getEvidence(callbackEvidence), undefined);
    }
    finally {
      denied.close();
    }
  }
  finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("native semantic exchange refuses stale input and duplicate-key responses", async () => {
  const { semanticExchange, parseSemanticResult } = await import("../src/graph/semantic.js");
  const request = semanticExchange([{ path: "a.md", digest: "hash", text: "Requirement" }], "op");
  const response = { kind: "rafi_graph_semantic_result", version: 1, operationId: "op", inputDigest: request.inputDigest, nodes: [], edges: [], origin: { provider: "host", operationId: "op" } };
  assert.deepEqual(parseSemanticResult(JSON.stringify(response), request), response);
  assert.throws(() => parseSemanticResult(JSON.stringify({ ...response, inputDigest: "old" }), request));
  assert.throws(() => parseSemanticResult(JSON.stringify(response).replace('"version":1', '"version":1,"version":1'), request));
});
test("transfer removes graph publication authority only from the staged database", async () => {
  const Database = (await import("better-sqlite3")).default;
  const { normalizeTransferredGraphState } = await import("../src/graph/storage.js");
  const root = project();
  const db = new WorkflowDb(root);
  const staged = join(root, "staged.sqlite");
  try {
    const store = db.graphStore();
    store.put("capability", "machine", { python: "/machine/private/python" });
    store.put("head", "scope", { generationId: "generation" });
    store.put("job", "pending", { state: "extracting", operationId: "pending" });
    store.lease("scope", "pending", Date.now(), 60000);
    // The real transfer path uses SQLite backup too; never alter the live DB.
    const live = new Database(db.path, { readonly: true });
    try {
      await live.backup(staged);
    }
    finally {
      live.close();
    }
    const exported = new Database(staged);
    try {
      normalizeTransferredGraphState(exported);
      assert.equal((exported.prepare("SELECT count(*) AS n FROM graph_leases").get() as {
        n: number;
      }).n, 0);
      assert.equal((exported.prepare("SELECT count(*) AS n FROM graph_records WHERE kind='capability' OR kind='head'").get() as {
        n: number;
      }).n, 0);
      assert.equal(JSON.parse((exported.prepare("SELECT value FROM graph_records WHERE kind='job'").get() as {
        value: string;
      }).value).state, "imported-history");
    }
    finally {
      exported.close();
    }
    assert.equal(store.get<{
      python: string;
    }>("capability", "machine")?.value.python, "/machine/private/python");
    assert.equal(store.get<{
      state: string;
    }>("job", "pending")?.value.state, "extracting");
  }
  finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("routine task completion and changed bytes alone never queue graph maintenance", async () => {
  const { queueGraphMaintenance, GRAPH_CHANGE_SIGNAL } = await import("../src/graph/boundary.js");
  const root = project();
  try {
    adoptGraph(root, { config: config(), authorization: "explicit" });
    queueGraphMaintenance(root, root, "format", "Formatted files", true);
    queueGraphMaintenance(root, root, "test", GRAPH_CHANGE_SIGNAL, false);
    const db = new WorkflowDb(root);
    try {
      assert.equal(db.graphStore().list("job").length, 0);
    }
    finally {
      db.close();
    }
    queueGraphMaintenance(root, root, "implementation", GRAPH_CHANGE_SIGNAL, true);
    queueGraphMaintenance(root, root, "implementation", GRAPH_CHANGE_SIGNAL, true);
    const next = new WorkflowDb(root);
    try {
      assert.equal(next.graphStore().list("job").length, 1);
    }
    finally {
      next.close();
    }
  }
  finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("tracked ignored files and nested exclusions revoke previously acquired graph evidence", async (t) => {
  let python: string;
  try {
    python = await resolveGraphPython();
  }
  catch (error) {
    t.skip(String(error));
    return;
  }
  const root = project();
  try {
    adoptGraph(root, { config: config(), authorization: "explicit" });
    execFileSync("git", ["add", "src/main.py"], { cwd: root });
    const result = await refreshGraph(root, root, "base", { python });
    assert.equal(result.state, "published", result.reason);
    const view = acquireGraphView(root, root, captureGraphCorpus(root, root, loadGraphConfig(root)));
    assert.ok("graph" in view);
    writeFileSync(join(root, "src", ".gitignore"), "main.py\n");
    assert.equal(captureGraphCorpus(root, root, loadGraphConfig(root)).inputs.length, 0);
    assert.equal((await readGraph(view, { operation: "query", query: "helper" })).status, "unavailable");
  }
  finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("graph adoption extends existing owned ignore block without replacing its ownership", async () => {
  const { registerOwnedFile, readInstallManifest } = await import("../src/installOwnership.js");
  const root = project();
  try {
    writeFileSync(join(root, ".gitignore"), "user-private/\n# rafi:start\n.rafi/\n# rafi:end\n");
    registerOwnedFile(root, ".gitignore", { mode: "managed-block", marker: "# rafi:start..# rafi:end", origin: "create", category: "managed-gitignore" });
    adoptGraph(root, { config: config(), authorization: "explicit" });
    assert.equal(readInstallManifest(root)?.files.find(f => f.path === ".gitignore")?.marker, "# rafi:start..# rafi:end");
    assert.match(readFileSync(join(root, ".gitignore"), "utf8"), /\.rafi\/\n\/graphify-out\/\n# rafi:end/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("expired publisher reservations release capacity but active publishers remain charged", () => {
  const root = project(), db = new WorkflowDb(root);
  try {
    const store = db.graphStore();
    const first = store.lease("s", "old", Date.now(), 60000);
    store.reserveStorage("old", 80, 0, 100, { scope: "s", owner: "old", fence: first });
    assert.throws(() => store.reserveStorage("new", 30, 0, 100), /admission/);
    store.release("s", "old", first);
    store.reserveStorage("new", 30, 0, 100);
    assert.equal(store.get("storage-reservation", "old"), undefined);
    assert.ok(store.get("storage-reservation", "new"));
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("status wrapper preserves explicit semantic runtime and does not invent an unknown runtime", async () => {
  const { RoleStatusAdapter } = await import("../src/statusReporter.js");
  const { graphSemanticHost } = await import("../src/graph/host.js");
  const settings = { model: "fixture-selected-model", effort: "high", runtimeExecutable: "/fixture/selected-cli" };
  const known = { agent: "codex", graphRuntimeSettings: () => settings } as unknown as BuilderAdapter;
  const wrapped = new RoleStatusAdapter(known, () => {}, () => {});
  assert.deepEqual(wrapped.graphRuntimeSettings(), settings);
  assert.equal(typeof graphSemanticHost("/unused", wrapped), "function");
  assert.equal(graphSemanticHost("/unused", new RoleStatusAdapter({ agent: "codex" } as BuilderAdapter, () => {}, () => {})), undefined);
});
