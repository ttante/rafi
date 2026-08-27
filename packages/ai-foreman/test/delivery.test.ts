import test from "node:test";
import assert from "node:assert/strict";
import { applySharedDeliveryBranch, buildBranchPlan } from "../src/branch/planner.js";
import { deliveryProgress, selectDeliveryUnitForRun, validateDeliveryConfig, type DeliveryConfig } from "../src/tickets/delivery.js";
import type { TicketDef } from "../src/tickets/ticketSchema.js";
import type { TicketState } from "../src/tickets/stateDb.js";

const tickets: TicketDef[] = ["A", "B", "C"].map((id, index) => ({ id, order: (index + 1) * 1000, title: id, area: "Core", priority: "P1", size: "S", risk: "Low", depends_on: index ? [["A", "B"][index - 1]!] : [], summary: id, acceptance: ["done"], required_tests: ["test"], likely_files: [] }));
const config: DeliveryConfig = { version: 1, units: [
  { id: "group-one", tickets: ["A", "B"], branch_mode: "shared", completion: "pr" },
  { id: "group-two", tickets: ["C"], branch_mode: "per-ticket", depends_on: ["group-one"], dependency_mode: "wait" },
] };

test("delivery validation rejects duplicate tickets and cycles", () => {
  assert.deepEqual(validateDeliveryConfig(config, tickets), []);
  const invalid = structuredClone(config);
  invalid.units[1]!.tickets = ["B"];
  invalid.units[0]!.depends_on = ["group-two"];
  assert.match(validateDeliveryConfig(invalid, tickets).map((item) => item.message).join("\n"), /already assigned|dependency cycle/);
});

test("delivery progress resumes unfinished groups and waits on dependencies", () => {
  const states = new Map<string, TicketState>();
  const progress = deliveryProgress(config, states);
  assert.equal(progress[0]!.state, "ready");
  assert.equal(progress[1]!.state, "waiting");
  states.set("A", { ticket_id: "A", status: "done" } as TicketState);
  assert.equal(selectDeliveryUnitForRun(config, states)?.unit.id, "group-one");
  assert.equal(selectDeliveryUnitForRun(config, states)?.state, "resume");
});

test("partial shared delivery uses one branch and defers final completion", () => {
  const plan = buildBranchPlan(tickets, new Map(), { steps: 1, baseRef: "main", branchPrefix: "rafi", maxBranchDepth: 2, ticketIds: ["A"] });
  const shared = applySharedDeliveryBranch(plan, "group-one", ["A", "B"], "rafi");
  assert.equal(shared.nodes[0]!.branch, "rafi/group-one");
  assert.equal(shared.nodes[0]!.deliveryUnitFinal, false);
});
