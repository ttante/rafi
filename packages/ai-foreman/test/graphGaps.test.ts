import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DEFAULT_GRAPH_CONFIG, type GraphExchangeV1 } from "rafi-spec";
import { adoptGraph, disableGraph } from "../src/graph/maintenance.js";
import { captureGraphCorpus, graphExclusions } from "../src/graph/corpus.js";
import { loadGraphConfig } from "../src/graph/config.js";
import { graphContext, sendGraphTurn } from "../src/graph/turn.js";
import { graphSemanticHost } from "../src/graph/host.js";
import { withGraphDerivedAccess } from "../src/graph/derived.js";
import { digest } from "../src/graph/util.js";
import { WorkflowDb } from "../src/workflowDb.js";
import type { BuilderAdapter, TurnResult } from "../src/adapters/types.js";
function fixture(git = true): string {
  const root = mkdtempSync(join(tmpdir(), "rafi-graph-gaps-"));
  if (git) execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/main.py"), "def main(): return 1\n");
  adoptGraph(root, { authorization: "explicit", config: { ...structuredClone(DEFAULT_GRAPH_CONFIG), mode: "code-only", include: ["src/**"] } });
  return root;
}
const turn = (text: string): TurnResult => ({ text, isError: false, numTurns: 1, costUsd: 0.1, costAuthoritative: true, usage: { scope: "turn-delta", inputTokens: 20, outputTokens: 10 } });
const request = JSON.stringify({ kind: "rafi_graph_request", version: 1, requestId: "r", operations: [{ operation: "query", query: "main" }] });
for (const failure of ["provider", "continuity", "protocol", "request-reuse"] as const) test(`failed graph exchange retains all usage: ${failure}`, async () => {
  const root = fixture();
  try {
    let calls = 0;
    const adapter = { agent: "codex", sessionId: () => "usage-session", sendTurn: async () => {
      calls++;
      if (failure === "protocol") return turn('{"kind":"rafi_graph_request",oops');
      if (calls === 1) return turn(request);
      if (failure === "provider") return { ...turn("provider failed"), isError: true };
      if (failure === "continuity") return { ...turn("invalid continuity"), continuityErrors: ["missing record"] };
      return turn(request.replace('"main"', '"changed"'));
    } } as unknown as BuilderAdapter;
    const result = await sendGraphTurn(adapter, "work", graphContext(root, root, "implementation", "work"));
    assert.equal(result.isError, true);
    assert.equal(calls, 2);
    assert.equal(result.numTurns, 2);
    assert.equal(result.costUsd, 0.2);
    assert.equal(result.usage?.inputTokens, 40);
    assert.equal(result.usage?.outputTokens, 20);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("Git-style Graphify exclusions preserve escapes, anchors, classes and excluded parents", () => {
  const root = fixture();
  try {
    mkdirSync(join(root, "src/nested"));
    mkdirSync(join(root, "src/blocked"));
    for (const name of ["a1.py", "a2.py", "#secret.py", "!private.py", "nested/keep.py", "blocked/keep.py", "keep.py"])
      writeFileSync(join(root, "src", name), "pass\n");
    writeFileSync(join(root, ".graphifyignore"), "/src/keep.py\nsrc/a[12].py\n\\#secret.py\n\\!private.py\nsrc/blocked/\n!src/blocked/keep.py\n");
    assert.deepEqual(captureGraphCorpus(root, root, loadGraphConfig(root)).inputs.map(i => i.path), ["src/main.py", "src/nested/keep.py"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("non-Git snapshots honor nested ignores and reject a word budget overflow", () => {
  const root = fixture(false);
  try {
    mkdirSync(join(root, "src/nested"));
    writeFileSync(join(root, ".gitignore"), "*.py\n");
    writeFileSync(join(root, "src/.gitignore"), "!main.py\n");
    writeFileSync(join(root, "src/nested/.gitignore"), "!allowed.py\n");
    writeFileSync(join(root, "src/nested/allowed.py"), "one two three four\n");
    writeFileSync(join(root, "src/nested/hidden.py"), "secret\n");
    const effective = loadGraphConfig(root);
    assert.deepEqual(captureGraphCorpus(root, root, effective).inputs.map(i => i.path), ["src/main.py", "src/nested/allowed.py"]);
    assert.throws(() => captureGraphCorpus(root, root, { ...effective, limits: { ...effective.limits, maxWords: 2 } }), /word limit/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("bound recovery resumes only the saved undispatched continuation and preserves cumulative usage", async () => {
  const root = fixture();
  try {
    const prompts: string[] = [];
    let crash = true, probes = 0;
    const adapter = { agent: "codex", sessionId: () => "bound-session", contextUsage: async () => {
      if (++probes === 2 && crash) throw new Error("simulated host crash before dispatch intent");
      return undefined;
    }, sendTurn: async (prompt: string) => { prompts.push(prompt); return turn(prompts.length === 1 ? request : "STEP_STATUS: done"); } } as unknown as BuilderAdapter;
    const context = graphContext(root, root, "implementation", "fixed work", { operationId: "recovery", logicalTaskId: "assignment" });
    await assert.rejects(sendGraphTurn(adapter, "fixed work", context), /simulated host crash/);
    const db = new WorkflowDb(root);
    try { assert.equal(db.graphStore().get<GraphExchangeV1>("exchange", "recovery")?.value.state, "read-completed"); } finally { db.close(); }
    await assert.rejects(sendGraphTurn(adapter, "different work", context), /cannot be replayed/);
    crash = false;
    const result = await sendGraphTurn(adapter, "fixed work", context);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /Continue the same frozen action/);
    assert.equal(result.numTurns, 2);
    assert.equal(result.usage?.inputTokens, 40);
    assert.equal(result.costUsd, 0.2);
    await assert.rejects(sendGraphTurn(adapter, "fixed work", context), /cannot be replayed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("malformed requests get one source fallback and cannot recursively consume repair turns", async () => {
  const root = fixture();
  try {
    const prompts: string[] = [];
    const adapter = { agent: "codex", sessionId: () => "s", sendTurn: async (prompt: string) => { prompts.push(prompt); return turn('{"kind":"rafi_graph_request",oops'); } } as unknown as BuilderAdapter;
    const result = await sendGraphTurn(adapter, "work", graphContext(root, root, "implementation", "work"));
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /No further graph requests/);
    assert.equal(result.isError, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("round exhaustion gives a terminal limitation followed by a normal business response", async () => {
  const root = fixture();
  try {
    adoptGraph(root, { authorization: "explicit", config: { ...loadGraphConfig(root).config!, limits: { rounds: 1 } } });
    const prompts: string[] = [];
    const adapter = { agent: "codex", sessionId: () => "s", sendTurn: async (prompt: string) => { prompts.push(prompt); return turn(prompts.length < 3 ? request : "STEP_STATUS: done"); } } as unknown as BuilderAdapter;
    const result = await sendGraphTurn(adapter, "work", graphContext(root, root, "implementation", "work"));
    assert.equal(result.isError, false);
    assert.equal(result.numTurns, 3);
    assert.match(prompts[2], /round budget exhausted/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("semantic repair usage is retained and completed chunks reuse without provider dispatch", async () => {
  const root = fixture();
  try {
    let count = 0;
    let request: { operationId: string; inputDigest: string };
    const host = { agent: "codex", graphRuntimeSettings: () => ({ model: "fixture-model" }) } as unknown as BuilderAdapter;
    const semantic = graphSemanticHost(root, host, async () => ({ sessionId: () => "semantic-session", close: async () => {}, sendTurn: async (text: string) => {
      count++;
      if (count === 1) { request = JSON.parse(text); return turn("bad JSON"); }
      return turn(JSON.stringify({ kind: "rafi_graph_semantic_result", version: 1, operationId: request.operationId, inputDigest: request.inputDigest, nodes: [{ id: "x", source_file: "doc.md" }], edges: [], origin: { provider: "codex", operationId: request.operationId } }));
    } } as unknown as BuilderAdapter))!;
    const chunks = [{ path: "doc.md", digest: "captured", text: "Requirement" }];
    await semantic(chunks, "semantic-job");
    await semantic(chunks, "semantic-job");
    assert.equal(count, 2);
    const db = new WorkflowDb(root);
    try {
      const jobs = db.graphStore().list<{ state: string; usage: { inputTokens: number; costUsd: number; observations: unknown[] } }>("job");
      const job = jobs.find(j => j.value.state === "completed")!.value;
      assert.equal(job.usage.inputTokens, 40);
      assert.equal(job.usage.costUsd, 0.2);
      assert.equal(job.usage.observations.length, 2);
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("revoked graph-derived continuity cannot enter successor reconstruction", () => {
  const root = fixture();
  try {
    const config = loadGraphConfig(root), db = new WorkflowDb(root);
    try {
      const access = { policyDigest: config.policyDigest, workspace: root, exclusionsDigest: digest("exclusions", graphExclusions(root).text), sourceVersions: {}, paths: [] };
      withGraphDerivedAccess(access, () => db.appendContinuityEvent({ runId: "run", role: "builder", kind: "source-observation", payload: { observed: "graph-derived relationship" }, authoritativeStateRevision: 0 }));
      assert.equal(db.continuityEvents("run").length, 1);
      disableGraph(root);
      assert.throws(() => db.continuityEvents("run"), /revoked graph-derived/);
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("semantic deadline bounds an unresponsive provider independently of close", async () => {
  const root = fixture();
  try {
    let closed = 0;
    const host = { agent: "codex", graphRuntimeSettings: () => ({ model: "fixture" }) } as unknown as BuilderAdapter;
    const semantic = graphSemanticHost(root, host, async () => ({ sessionId: () => "hung", sendTurn: () => new Promise(() => {}), close: async () => { closed++; } } as unknown as BuilderAdapter))!;
    const started = Date.now();
    await assert.rejects(semantic([{ path: "doc.md", digest: "x", text: "requirement" }], "hung-operation", { deadline: Date.now() + 500 }), /deadline exceeded/);
    assert.ok(Date.now() - started < 3000);
    assert.equal(closed, 1);
    await assert.rejects(semantic([{ path: "doc.md", digest: "x", text: "requirement" }], "hung-operation"), /refusing replay/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("a semantic worker created after its deadline is still closed", async () => {
  const root = fixture();
  try {
    let closed = 0, sends = 0;
    let release!: () => void;
    const created = new Promise<void>(resolve => { release = resolve; });
    const host = { agent: "codex", graphRuntimeSettings: () => ({ model: "fixture" }) } as unknown as BuilderAdapter;
    const semantic = graphSemanticHost(root, host, async () => {
      await created;
      return { close: async () => { closed++; }, sendTurn: async () => { sends++; return turn("unexpected"); } } as unknown as BuilderAdapter;
    })!;
    await assert.rejects(semantic([{ path: "doc.md", digest: "x", text: "requirement" }], "late-worker", { deadline: Date.now() + 100 }), /deadline exceeded/);
    release();
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(closed, 1); assert.equal(sends, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("later provider turns inherit graph provenance and revocation stops redisclosure", async () => {
  const { dispatchWithGraphAccess } = await import("../src/graph/session.js");
  const root = fixture();
  try {
    const config = loadGraphConfig(root);
    const access = { policyDigest: config.policyDigest, workspace: root, exclusionsDigest: digest("exclusions", graphExclusions(root).text), sourceVersions: {}, paths: [] };
    let calls = 0;
    const adapter = { agent: "codex", sessionId: () => "retained", sendTurn: async () => { calls++; return turn(`derived response ${calls}`); } } as unknown as BuilderAdapter;
    await dispatchWithGraphAccess(root, adapter, "graph packet", undefined, (text, p) => adapter.sendTurn(text, p), [access]);
    const subsequent = await dispatchWithGraphAccess(root, adapter, "follow-up without a graph query", undefined, (text, p) => adapter.sendTurn(text, p));
    const db = new WorkflowDb(root);
    try {
      const blob = db.putEvidence("qa", Buffer.from(subsequent.text));
      assert.ok(db.getEvidence(blob));
      disableGraph(root);
      assert.equal(db.getEvidence(blob), undefined);
    } finally { db.close(); }
    await assert.rejects(dispatchWithGraphAccess(root, adapter, "later", undefined, (text, p) => adapter.sendTurn(text, p)), /revoked graph evidence/);
    assert.equal(calls, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("registered source pins reject mutation and never substitute the newest capture", () => {
  const root = fixture();
  try {
    const oldText = "captured approved input\n", newText = "new proposal\n";
    const fingerprint = (text: string) => createHash("sha256").update(text).digest("hex");
    mkdirSync(join(root, ".rafi/source-cache"), { recursive: true });
    writeFileSync(join(root, ".rafi/source-cache/old.md"), oldText);
    writeFileSync(join(root, ".rafi/source-cache/new.md"), newText);
    const versions = [oldText, newText].map((text, index) => ({ fingerprint: fingerprint(text), captured_at: "2026-10-10T00:00:00Z", storage: "local", snapshot_path: `.rafi/source-cache/${index ? "new" : "old"}.md`, manifest_path: "manifest.json" }));
    writeFileSync(join(root, "rafi-config.yaml"), JSON.stringify({ sources: { version: 1, snapshot_storage: "local", entries: [{ id: "requirements", type: "local", label: "Requirements", active: true, locator: { path: "requirements.md" }, versions }] } }));
    adoptGraph(root, { authorization: "explicit", config: { ...structuredClone(DEFAULT_GRAPH_CONFIG), sourceIds: ["requirements"], sourceVersions: { requirements: fingerprint(oldText) }, include: ["src/**"] } });
    const captured = captureGraphCorpus(root, root, loadGraphConfig(root));
    const source = captured.inputs.find(i => i.sourceId === "requirements")!;
    assert.equal(captured.bytes.get(source.path)?.toString(), oldText);
    writeFileSync(join(root, ".rafi/source-cache/old.md"), "mutated\n");
    assert.throws(() => captureGraphCorpus(root, root, loadGraphConfig(root)), /capture checksum mismatch/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("checkout invalidation preserves immutable history and pruning waits 24 hours for abandoned staging", async () => {
  const { invalidateGraphWorkspace, pruneGraph } = await import("../src/graph/lifecycle.js");
  const { graphScope } = await import("../src/graph/read.js");
  const { existsSync, utimesSync } = await import("node:fs");
  const root = fixture();
  try {
    const id = "a".repeat(64), scope = graphScope(root), db = new WorkflowDb(root);
    try {
      const store = db.graphStore();
      store.put("head", scope, { generationId: id });
      store.put("generation", id, { id, createdAt: new Date().toISOString(), binding: { workspaceRef: scope } });
      invalidateGraphWorkspace(root, root, "merge-or-rebase");
      assert.equal(store.get("head", scope), undefined);
      assert.ok(store.get("generation", id));
      store.put("job", id, { scope });
      const abandoned = join(root, "graphify-out/rafi/staging", `${id}-1`);
      mkdirSync(abandoned, { recursive: true });
      pruneGraph(root);
      assert.ok(existsSync(abandoned));
      const old = new Date(Date.now() - 25 * 3600000);
      utimesSync(abandoned, old, old);
      pruneGraph(root);
      assert.equal(existsSync(abandoned), false);
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("state transfer withholds embedded continuity and blob bytes without changing live evidence", async () => {
  const Database = (await import("better-sqlite3")).default;
  const { normalizeTransferredGraphState } = await import("../src/graph/storage.js");
  const { readFileSync } = await import("node:fs");
  const root = fixture();
  const db = new WorkflowDb(root);
  try {
    const config = loadGraphConfig(root), secret = "unique-graph-derived-private-observation-4429";
    const access = { policyDigest: config.policyDigest, workspace: root, exclusionsDigest: digest("exclusions", graphExclusions(root).text), sourceVersions: {}, paths: [] };
    const blob = withGraphDerivedAccess(access, () => {
      db.qaPreparationStore().putArtifact("investigation-evidence", { text: secret });
      db.appendContinuityEvent({ runId: "transfer", role: "builder", kind: "observation", payload: { text: secret }, authoritativeStateRevision: 0 });
      return db.putEvidence("qa", Buffer.from(secret));
    });
    const copy = join(root, "transfer.sqlite"), source = new Database(db.path, { readonly: true });
    try { await source.backup(copy); } finally { source.close(); }
    const staged = new Database(copy);
    try {
      normalizeTransferredGraphState(staged);
      const payload = (staged.prepare("SELECT payload_json FROM continuity_events WHERE run_id='transfer'").get() as { payload_json: string }).payload_json;
      assert.match(payload, /graph-evidence-withheld/);
      assert.ok(!payload.includes(secret));
      const artifact = staged.prepare("SELECT record_json FROM qa_contract_artifacts WHERE kind='investigation-evidence'").get() as { record_json: string };
      assert.match(artifact.record_json, /graph-evidence-withheld/);
      assert.ok(!artifact.record_json.includes(secret));
      assert.equal(staged.prepare("SELECT content FROM content_refs WHERE digest=?").get(blob), undefined);
      normalizeTransferredGraphState(staged); // Re-import is idempotent and remains withheld.
    } finally { staged.close(); }
    assert.ok(!readFileSync(copy).includes(Buffer.from(secret)));
    assert.equal(db.getEvidence(blob)?.toString(), secret);
    assert.deepEqual(db.continuityEvents("transfer")[0].payload, { text: secret });
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
test("graph delivery journal blocks legacy writers without changing preparation's schema version", async () => {
  const Database = (await import("better-sqlite3")).default;
  const { registerQaGraphJournalWriter, ensureQaGraphJournalGuards } = await import("../src/qaDeliveryJournal.js");
  const root = mkdtempSync(join(tmpdir(), "graph-journal-compat-")), file = join(root, "journal.sqlite");
  const current = new Database(file);
  try {
    current.exec("CREATE TABLE qa_delivery_turns(id TEXT PRIMARY KEY, value TEXT); PRAGMA user_version=4");
    registerQaGraphJournalWriter(current);
    ensureQaGraphJournalGuards(current);
    current.prepare("INSERT INTO qa_delivery_turns VALUES(?,?)").run("turn", "graph-continuation");
    const legacy = new Database(file);
    try {
      assert.throws(() => legacy.prepare("UPDATE qa_delivery_turns SET value='response-repair'").run(), /rafi_graph_delivery_protocol/);
      assert.equal(legacy.pragma("user_version", { simple: true }), 4);
    } finally { legacy.close(); }
    current.prepare("UPDATE qa_delivery_turns SET value='completed'").run();
  } finally { current.close(); rmSync(root, { recursive: true, force: true }); }
});
test("plain diagnostic logs retain metadata rather than graph-derived text", async () => {
  const { Log } = await import("../src/log.js");
  const { readFileSync } = await import("node:fs");
  const root = fixture();
  try {
    const config = loadGraphConfig(root), file = join(root, "log.jsonl"), log = new Log(file);
    const access = { policyDigest: config.policyDigest, workspace: root, exclusionsDigest: digest("exclusions", graphExclusions(root).text), sourceVersions: {}, paths: [] };
    withGraphDerivedAccess(access, () => log.write("graph-evidence", { summary: "private graph inference" }));
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(saved.graphDerived, true);
    assert.ok(saved.fieldsDigest);
    assert.ok(!readFileSync(file, "utf8").includes("private graph inference"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("optional evidence quota accumulates across operations without resetting on recovery", () => {
  const root = fixture(), db = new WorkflowDb(root);
  try {
    const store = db.graphStore();
    assert.equal(store.admitEvidence("run", "first", 60, 100), true);
    assert.equal(store.admitEvidence("run", "second", 41, 100), false);
    assert.equal(store.admitEvidence("run", "first", 1, 100), true);
    assert.equal(store.admitEvidence("run", "second", 40, 100), true);
    assert.equal(store.admitEvidence("run", "third", 1, 100), false);
    assert.throws(() => store.admitEvidence("other-run", "first", 1, 100), /changed run scope/);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
test("accepted active-source policy follows intake, pins old versions, and labels references without approval", async () => {
  const { saveSourceRegistry } = await import("../src/sources/sourceRegistry.js");
  const root = fixture();
  try {
    mkdirSync(join(root, ".rafi/source-cache"), { recursive: true });
    const capture = (name: string, text: string) => {
      writeFileSync(join(root, `.rafi/source-cache/${name}.md`), text);
      return { fingerprint: createHash("sha256").update(text).digest("hex"), captured_at: "2026-10-10T00:00:00Z", storage: "local" as const, snapshot_path: `.rafi/source-cache/${name}.md`, manifest_path: "manifest.json" };
    };
    const first = capture("first", "reference one\n"), second = capture("second", "later proposal\n");
    const entry = { id: "spec", type: "local" as const, label: "Captured proposal", active: true, locator: { path: "proposal.md" }, versions: [first] };
    const registry = { version: 1 as const, snapshot_storage: "local" as const, entries: [entry] };
    saveSourceRegistry(root, registry);
    assert.equal(loadGraphConfig(root).config?.sourceVersions?.spec, first.fingerprint);
    entry.versions.push(second);
    saveSourceRegistry(root, registry);
    assert.equal(loadGraphConfig(root).config?.sourceVersions?.spec, first.fingerprint);
    const source = captureGraphCorpus(root, root, loadGraphConfig(root)).inputs.find(i => i.sourceId === "spec")!;
    assert.equal(source.provenance?.authority, "reference-only; approval not inferred");
    assert.equal(source.provenance?.label, "Captured proposal");
    adoptGraph(root, { authorization: "setup", config: structuredClone(DEFAULT_GRAPH_CONFIG) });
    assert.equal(loadGraphConfig(root).config?.sourceVersions?.spec, first.fingerprint);
    entry.active = false;
    saveSourceRegistry(root, registry);
    assert.deepEqual(loadGraphConfig(root).config?.sourceIds, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
