import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DEFAULT_GRAPH_CONFIG } from "rafi-spec";
import { adoptGraph } from "ai-foreman/graph-maintenance.js";
import { initializeSetupGraph } from "../src/graphSetup.js";
import type { createRoleBuilder, RoleBuilder } from "ai-foreman/agent-run.js";
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "rafi-graph-setup-"));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/main.py"), "def helper(): return 1\n");
  return root;
}
test("AST-only accepted setup publishes without creating a provider host", async t => {
  const python = process.env.RAFI_GRAPH_PYTHON;
  if (!python) { t.skip("Set RAFI_GRAPH_PYTHON to an existing certified Graphify installation"); return; }
  const root = fixture();
  try {
    adoptGraph(root, { authorization: "setup", config: { ...structuredClone(DEFAULT_GRAPH_CONFIG), mode: "code-only", include: ["src/**"] } });
    const outcome = await initializeSetupGraph(root, "initial", python, async () => { throw new Error("AST-only setup must not create a provider"); });
    assert.equal(outcome.state, "published", outcome.reason);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("mixed setup selects only its Planner host and closes it on unavailable capability", async () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "src/requirements.md"), "Preserve callers.\n");
    adoptGraph(root, { authorization: "setup", config: { ...structuredClone(DEFAULT_GRAPH_CONFIG), include: ["src/**"] } });
    let created = 0, closed = 0;
    const createHost: typeof createRoleBuilder = async options => {
      created++;
      assert.equal(options.role, "planner");
      assert.equal(options.allowSwitch, false);
      assert.equal(options.persistSessionBindings, false);
      assert.equal(options.projectDir, root);
      return { builder: { close: async () => { closed++; } } } as unknown as RoleBuilder;
    };
    const outcome = await initializeSetupGraph(root, "initial", "unused-python", createHost);
    assert.equal(outcome.state, "failed");
    assert.match(outcome.reason!, /selected setup host/);
    assert.equal(created, 1);
    assert.equal(closed, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("accepted setup resumes an unstarted graph but never replays an intended initialization", async () => {
  const { pendingSetupGraph } = await import("../src/graphSetup.js");
  const { WorkflowDb } = await import("ai-foreman/workflow-db.js");
  const root = fixture();
  try {
    assert.equal(pendingSetupGraph(root), undefined);
    const adoption = adoptGraph(root, { authorization: "setup", config: { ...structuredClone(DEFAULT_GRAPH_CONFIG), mode: "code-only" } });
    assert.equal(pendingSetupGraph(root)?.initialOperationId, adoption.initialOperationId);
    const db = new WorkflowDb(root);
    try { db.graphStore().put("job", `setup:${adoption.initialOperationId}`, { state: "setup-initial-intended" }); } finally { db.close(); }
    assert.equal(pendingSetupGraph(root), undefined);
    await assert.rejects(initializeSetupGraph(root, adoption.initialOperationId, "unused", async () => { throw new Error("must not create host"); }), /already started/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
