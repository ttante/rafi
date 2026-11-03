// The five load checks of ARCH 4.8: standard passes; planted broken workflows each fail one check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkWorkflow } from "../../src/workflow/checks.js";
import { findWorkflow, workflowDigest } from "../../src/workflow/load.js";
import { standard } from "../../src/workflow/standard.js";
import type { Workflow, WorkflowNode } from "../../src/workflow/types.js";

const node = (id: string, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({
  id, step: id, state: "building", type: "rafi", role: null, onPass: "done", onFail: "blocked", ...extra,
});
const wf = (nodes: WorkflowNode[], start = nodes[0]!.id): Workflow => ({ id: "x", version: 1, start, nodes });
const checksOf = (w: Workflow) => [...new Set(checkWorkflow(w).map((p) => p.check))];

test("standard passes every load check, and is frozen data", () => {
  assert.deepEqual(checkWorkflow(standard), []);
  assert.ok(Object.isFrozen(standard) && Object.isFrozen(standard.nodes[0]));
  assert.equal(findWorkflow({ id: "standard", version: 1, digest: workflowDigest(standard) }), standard);
  assert.equal(findWorkflow({ id: "standard", version: 1, digest: "sha256:other" }), undefined);
});

test("an unreachable step fails", () => {
  assert.deepEqual(checksOf(wf([node("a"), node("b")])), ["reachable"]);
});

test("a fail path that doesn't end fails", () => {
  const w = wf([node("a", { onFail: "b", onPass: "b" }), node("b", { onFail: "a", onPass: "done" })]);
  assert.ok(checksOf(w).includes("fail-ends"));
});

test("a loop without a limit fails", () => {
  const w = wf([node("a", { onPass: "b" }), node("b", { onPass: "a" })]);
  assert.deepEqual(checksOf(w), ["loop-limit"]);
  const limited = wf([node("a", { onPass: "b" }),
    node("b", { onPass: "a", limit: { setting: "retries.fixes", exhausted: "blocked" } })]);
  assert.deepEqual(checksOf(limited), []);
});

test("an unknown role fails", () => {
  assert.deepEqual(checksOf(wf([node("a", { type: "maker", role: "designer" })])), ["role-exists"]);
});

test("a checker step with a write role fails", () => {
  assert.deepEqual(checksOf(wf([node("a", { type: "checker", role: "builder" })])), ["type-fits-role"]);
});
