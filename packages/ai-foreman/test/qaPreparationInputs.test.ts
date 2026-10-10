import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StructuredPlanV1 } from "rafi-spec";
import type { TicketDef } from "../src/tickets/ticketSchema.js";
import { canonicalJson } from "../src/qaProtocolV2.js";
import { admittedPlanInput } from "../src/qaPreparationInputs.js";

test("exact approved revision inventories global and slice obligations with order-independent occurrence identity", () => {
  const root = mkdtempSync(join(tmpdir(), "qa-plan-input-"));
  try {
    mkdirSync(join(root, "docs", "rafi-plans"), { recursive: true });
    const plan: StructuredPlanV1 = { version: 1, plan_id: "approved-plan", revision: 1, content_digest: "", summary: "Token guard", assumptions: [], implementation_changes: ["Reject expired tokens"], acceptance_criteria: ["Preserve authorization invariants"], test_plan: ["Run coordinated regression"], slices: [{ slice_ref: "expiry", title: "Expiry", summary: "Reject expired tokens", acceptance: ["Reject expired", "Preserve valid", "Reject expired"], required_tests: ["Expiry test"], likely_files: [], depends_on: [] }], delivery_units: [], stacks: [] };
    const ticket = { plan_ref: { plan_id: plan.plan_id, revision: 1, slice_ref: "expiry" } } as TicketDef;
    const save = () => { plan.content_digest = createHash("sha256").update(canonicalJson({ ...plan, content_digest: "" })).digest("hex"); writeFileSync(join(root, "docs", "rafi-plan.json"), JSON.stringify(plan)); };
    save(); const first = admittedPlanInput(root, ticket)!;
    assert.equal(first.requirements.length, 6); assert.equal(new Set(first.requirements.map(req => req.id)).size, 6);
    assert.ok(first.requirements.some(req => req.locator === "acceptance_criteria[0]"));
    assert.ok(first.requirements.some(req => req.locator === "test_plan[0]"));
    const original = first.requirements.find(req => req.statement === "Preserve valid")!;
    plan.slices[0]!.acceptance = ["Preserve valid", "Reject expired", "Reject expired"]; save();
    assert.equal(admittedPlanInput(root, ticket)!.requirements.find(req => req.statement === "Preserve valid")!.id, original.id);
    writeFileSync(join(root, "docs", "rafi-plans", "revision-1.json"), JSON.stringify(plan));
    plan.revision = 2; save(); assert.equal(admittedPlanInput(root, ticket)!.plan.revision, 1);
    writeFileSync(join(root, "docs", "rafi-plans", "revision-1.json"), JSON.stringify({ ...plan, revision: 1 }));
    assert.throws(() => admittedPlanInput(root, ticket), /Corrupt admitted/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
