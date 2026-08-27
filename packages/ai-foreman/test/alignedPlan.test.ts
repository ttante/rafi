import test from "node:test";
import assert from "node:assert/strict";
import { evaluateTicketEligibility, eligibleTickets } from "../src/tickets/eligibility.js";
import { DEFAULT_TICKET_SETUP } from "../src/tickets/setupConfig.js";
import { renderReviewBody, renderReviewTitle } from "../src/tickets/reviewStandards.js";
import { buildQaReviewHandoff } from "../src/qaReview.js";
import { combineRequirementSelections } from "../src/cli/tickets.js";
import type { TicketDef } from "../src/tickets/ticketSchema.js";
import type { TicketState } from "../src/tickets/stateDb.js";

function ticket(id: string, order: number, patch: Partial<TicketDef> = {}): TicketDef {
  return { id, order, title: `Title ${id}`, area: "Accounts", priority: "P1", size: "S", risk: "Low", depends_on: [], summary: `Full ${id} summary`, acceptance: ["accepted"], required_tests: ["unit test"], likely_files: ["src/account.ts"], ...patch };
}

test("eligibility covers recommendation, dependencies, terminal/window, ownership, lease, and stack order", () => {
  const tickets = [ticket("T001", 1000), ticket("T002", 2000, { depends_on: ["T001"] }), ticket("T003", 3000), ticket("T004", 4000)];
  const states = new Map<string, TicketState>();
  assert.deepEqual(eligibleTickets({ tickets, states, implementationLimit: 3 }).map((item) => item.id), ["T001", "T003"]);
  assert.equal(evaluateTicketEligibility({ tickets, states, implementationLimit: 3 }, "T001").recommended, true);
  assert.deepEqual(evaluateTicketEligibility({ tickets, states, implementationLimit: 3 }, "T002").blockers.map((item) => item.code), ["dependencies"]);
  assert.equal(evaluateTicketEligibility({ tickets, states, implementationLimit: 3 }, "T004").blockers.some((item) => item.code === "outside-window"), true);
  states.set("T001", { ticket_id: "T001", status: "done" } as TicketState);
  assert.equal(evaluateTicketEligibility({ tickets, states, implementationLimit: 3 }, "T001").blockers.some((item) => item.code === "terminal"), true);
  states.set("T003", { ticket_id: "T003", status: "in_progress", owner: "run-old" } as TicketState);
  assert.equal(evaluateTicketEligibility({ tickets, states, implementationLimit: 3 }, "T003").blockers.some((item) => item.code === "resumable-owner"), true);
  assert.equal(evaluateTicketEligibility({ tickets, states, implementationLimit: 3, activeLease: { runId: "active" } }, "T002").blockers.some((item) => item.code === "active-lease"), true);
  const delivery = { version: 1 as const, units: [{ id: "one", tickets: ["T002"], branch_mode: "per-ticket" as const }, { id: "two", tickets: ["T004"], branch_mode: "per-ticket" as const }], stacks: [{ id: "stack", name: "Stack", units: ["one", "two"] }] };
  assert.equal(evaluateTicketEligibility({ tickets, states, implementationLimit: 4, delivery }, "T004").blockers.some((item) => item.code === "delivery-constraint"), true);
  assert.equal(evaluateTicketEligibility({ tickets, states, implementationLimit: 4 }, "missing").blockers[0]?.code, "missing");
});

test("configured review standards drive titles, body sections, and QA checklist handoff", () => {
  const definition = ticket("T123", 1000, { title: "Add password reset" });
  const build = structuredClone(DEFAULT_TICKET_SETUP.build);
  assert.equal(renderReviewTitle(build, definition), "T123: Add password reset");
  build.review.title_style = "conventional";
  assert.equal(renderReviewTitle(build, definition), "feat(accounts): Add password reset");
  build.review.title_style = "custom"; build.review.title_template = "[{id}] {area} - {title}";
  assert.equal(renderReviewTitle(build, definition), "[T123] Accounts - Add password reset");
  const node = { ticket: definition, branch: "feature/t123-add-password-reset", baseRef: "main", baseBranch: "main", dependencies: [], depth: 1 };
  const body = renderReviewBody(build, node);
  for (const section of build.review.description_sections) assert.match(body, new RegExp(`## ${section}`));
  for (const item of build.validation_checklist) assert.match(body, new RegExp(item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const handoff = buildQaReviewHandoff(definition, "implemented", "abc123", ["custom project check"]);
  assert.match(handoff, /Project validation checklist: custom project check/);
});

test("setup requirement selection keeps chosen defaults and adds unique custom requirements", () => {
  assert.deepEqual(
    combineRequirementSelections(["Summary", "Tests"], "Tests, Rollback notes, Evidence"),
    ["Summary", "Tests", "Rollback notes", "Evidence"],
  );
  assert.deepEqual(combineRequirementSelections([], ""), []);
});
