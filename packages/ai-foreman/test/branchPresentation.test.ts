import test from "node:test";
import assert from "node:assert/strict";

import { applySharedDeliveryBranch } from "../src/branch/planner.js";
import { branchPlanLogMetadata, presentBranchPlan } from "../src/branch/presentation.js";
import type { BranchPlan, BranchPlanNode } from "../src/branch/types.js";
import { applyExplicitStackTopology } from "../src/cli/start.js";
import type { DeliveryConfig, DeliveryStack } from "../src/tickets/delivery.js";
import type { TicketDef } from "../src/tickets/ticketSchema.js";

function ticket(id: string, order: number): TicketDef {
  return {
    id,
    order,
    title: id,
    area: "Core",
    priority: "P1",
    size: "S",
    risk: "Low",
    depends_on: [],
    summary: id,
    acceptance: ["done"],
    required_tests: ["test"],
    likely_files: [],
    rollback: null,
    notes: null,
  };
}

function node(id: string, order: number, sharedUnit?: string): BranchPlanNode {
  return {
    ticket: ticket(id, order),
    branch: `rafi/${id.toLowerCase()}`,
    baseRef: "main",
    baseBranch: "main",
    dependencies: [],
    depth: 1,
    ...(sharedUnit ? { deliveryUnitId: sharedUnit, deliveryUnitFinal: false } : {}),
  };
}

function plan(nodes: BranchPlanNode[]): BranchPlan {
  return { baseRef: "main", nodes, issues: [] };
}

test("branch presentation uses exact final-plan banner and prompt wording", () => {
  const cases = [
    {
      name: "per-ticket",
      value: presentBranchPlan(plan([node("A", 1000), node("B", 2000)])),
      mode: "per-ticket",
      description: "one branch per ticket",
      banner: "foreman: one branch per ticket for 2 ticket(s)",
      prompt: "Proceed with one branch per ticket?",
    },
    {
      name: "shared",
      value: presentBranchPlan(plan([node("A", 1000, "unit"), node("B", 2000, "unit")])),
      mode: "shared",
      description: "one shared branch",
      banner: "foreman: one shared branch for 2 ticket(s)",
      prompt: "Proceed with one shared branch?",
    },
    {
      name: "mixed",
      value: presentBranchPlan(plan([node("A", 1000, "unit"), node("B", 2000)])),
      mode: "mixed",
      description: "mixed shared and per-ticket branches",
      banner: "foreman: mixed shared and per-ticket branches for 2 ticket(s)",
      prompt: "Proceed with mixed shared and per-ticket branches?",
    },
    {
      name: "stacked",
      value: presentBranchPlan(plan([node("A", 1000, "unit"), node("B", 2000)]), { stacked: true }),
      mode: "mixed",
      description: "stacked delivery branches",
      banner: "foreman: stacked delivery branches for 2 ticket(s)",
      prompt: "Proceed with stacked delivery branches?",
    },
  ] as const;

  for (const item of cases) {
    assert.equal(item.value.allocationMode, item.mode, item.name);
    assert.equal(item.value.description, item.description, item.name);
    assert.equal(item.value.banner, item.banner, item.name);
    assert.equal(item.value.prompt, item.prompt, item.name);
  }
});

test("partial shared and resumed plans retain shared execution wording", () => {
  const partial = applySharedDeliveryBranch(plan([node("A", 1000)]), "unit", ["A", "B"]);
  assert.equal(partial.nodes[0]?.deliveryUnitFinal, false);
  const presentation = presentBranchPlan(partial, { resumed: true });
  assert.equal(presentation.allocationMode, "shared");
  assert.equal(presentation.banner, "foreman: resuming one shared branch for 1 ticket(s)");
  assert.equal(presentation.prompt, "Proceed with one shared branch?");
});

test("stack presentation preserves allocation metadata for all-shared, all-per-ticket, and mixed stacks", () => {
  assert.equal(presentBranchPlan(plan([node("A", 1000, "one"), node("B", 2000, "two")]), { stacked: true }).allocationMode, "shared");
  assert.equal(presentBranchPlan(plan([node("A", 1000), node("B", 2000)]), { stacked: true }).allocationMode, "per-ticket");
  assert.equal(presentBranchPlan(plan([node("A", 1000, "one"), node("B", 2000)]), { stacked: true }).allocationMode, "mixed");
});

test("branch-plan metadata records names after shared and stack transformations", () => {
  const shared = applySharedDeliveryBranch(plan([node("A", 1000), node("B", 2000)]), "shared unit", ["A", "B"]);
  const sharedMetadata = branchPlanLogMetadata(shared, presentBranchPlan(shared));
  assert.deepEqual(sharedMetadata.branches, [
    { ticket: "A", branch: "rafi/shared-unit", base: "main" },
    { ticket: "B", branch: "rafi/shared-unit", base: "main" },
  ]);
  assert.equal(sharedMetadata.branchMode, "shared");

  const stack: DeliveryStack = { id: "stack", name: "Stack", units: ["shared unit", "tip"] };
  const delivery: DeliveryConfig = { version: 1, units: [
    { id: "shared unit", tickets: ["A", "B"], branch_mode: "shared" },
    { id: "tip", tickets: ["C"], branch_mode: "per-ticket" },
  ], stacks: [stack] };
  const stacked = applyExplicitStackTopology(plan([node("A", 1000), node("B", 2000), node("C", 3000)]), [stack], delivery, "delivery");
  const stackedMetadata = branchPlanLogMetadata(stacked, presentBranchPlan(stacked, { stacked: true }));
  assert.deepEqual(stackedMetadata.branches, [
    { ticket: "A", branch: "delivery/shared-unit", base: "main" },
    { ticket: "B", branch: "delivery/shared-unit", base: "main" },
    { ticket: "C", branch: "rafi/c", base: "delivery/shared-unit" },
  ]);
  assert.equal(stackedMetadata.branchMode, "mixed");
  assert.equal(stackedMetadata.executionDescription, "stacked delivery branches");
});
