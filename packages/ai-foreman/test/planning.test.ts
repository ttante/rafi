import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { cmdInit } from "../src/tickets/commands.js";
import { loadTickets } from "../src/tickets/ticketLoader.js";
import { loadTicketsConfig, resolveTicketPaths } from "../src/tickets/config.js";
import { StateDb } from "../src/tickets/stateDb.js";
import {
  applyApprovedTicketPlan,
  extractTicketPlanProposal,
  PROPOSAL_END,
  PROPOSAL_START,
  ticketPlanningFingerprint,
  validateTicketPlanProposal,
  type TicketPlanProposal,
} from "../src/ticketPlanning.js";
import type { TicketDef } from "../src/tickets/ticketSchema.js";

function dir(): string { return mkdtempSync(join(tmpdir(), "rafi-ticket-plan-")); }
function ticket(id: string, order = 1000): TicketDef {
  return { id, order, title: `Ticket ${id}`, area: "Core", priority: "P1", size: "S", risk: "Low", depends_on: [], summary: "Implement it", acceptance: ["It works"], required_tests: ["Unit tests"], likely_files: ["src/index.ts"] };
}
function proposal(additions: TicketDef[] = [ticket("T001")]): TicketPlanProposal {
  return { version: 1, title: "Plan", markdown: "# Plan\n\nApproved work.", additions, edits: [], supersessions: [], state_changes: [], source_reconciliation: [], future_work: [], next: { ticket_ids: additions.map((item) => item.id), replace_existing: false } };
}

test("proposal envelope parses and validation enforces provenance", () => {
  const value = proposal();
  const output = `Readable\n${PROPOSAL_START}\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n${PROPOSAL_END}\nSTEP_STATUS: plan_complete | summary="proposal_ready"`;
  assert.deepEqual(extractTicketPlanProposal(output), value);
  value.source_reconciliation.push({ source: "spec", item: "REQ-1", disposition: "mapped", ticket_ids: ["T001"] });
  assert.match(validateTicketPlanProposal(value).join("\n"), /missing source_refs provenance/);
  value.additions[0]!.source_refs = [{ source: "spec", item: "REQ-1" }];
  assert.deepEqual(validateTicketPlanProposal(value), []);
});

test("proposal envelope validates edits against existing tracker tickets", () => {
  const existing = ticket("T001");
  const value = proposal([]);
  value.edits = [{ id: "T001", patch: { summary: "Refined implementation" } }];
  value.next = { ticket_ids: ["T001"], replace_existing: false };
  const output = `${PROPOSAL_START}\n${JSON.stringify(value)}\n${PROPOSAL_END}`;

  assert.deepEqual(extractTicketPlanProposal(output, [existing]), value);
  assert.throws(() => extractTicketPlanProposal(output), /unknown ticket T001/);
});

test("approved proposal applies exact tickets, next state, artifacts, and validation", () => {
  const project = dir();
  cmdInit(project, { appName: "Plan Test", docsRoot: "docs" });
  const expected = ticketPlanningFingerprint(project);
  const applied = applyApprovedTicketPlan(project, proposal(), { expectedFingerprint: expected, docsRoot: "docs", now: new Date("2026-08-18T12:00:00Z") });
  const paths = resolveTicketPaths(loadTicketsConfig(project), project);
  assert.deepEqual(loadTickets(paths.tickets).map((item) => item.id), ["T001"]);
  const db = new StateDb(paths.stateDb);
  assert.equal(db.getState("T001")?.status, "next");
  db.close();
  assert.ok(existsSync(join(project, applied.artifacts[0]!)));
  assert.ok(existsSync(join(project, applied.artifacts[1]!)));
  assert.match(readFileSync(paths.progressDoc, "utf8"), /T001/);
  assert.match(readFileSync(join(project, applied.backupDir, "journal.json"), "utf8"), /"status": "committed"/);
});

test("apply detects drift and rolls back YAML when a SQLite disposition fails", () => {
  const project = dir();
  cmdInit(project, { appName: "Rollback", docsRoot: "docs" });
  const driftFingerprint = ticketPlanningFingerprint(project);
  writeFileSync(join(project, ".tickets", "tickets.yaml"), "tickets: []\n# changed\n", "utf8");
  assert.throws(() => applyApprovedTicketPlan(project, proposal(), { expectedFingerprint: driftFingerprint, docsRoot: "docs" }), /changed after proposal generation/);

  const expected = ticketPlanningFingerprint(project);
  const bad = proposal();
  bad.future_work = [{ id: 999, disposition: "rejected" }];
  assert.throws(() => applyApprovedTicketPlan(project, bad, { expectedFingerprint: expected, docsRoot: "docs" }), /does not exist/);
  const raw = parse(readFileSync(join(project, ".tickets", "tickets.yaml"), "utf8")) as { tickets: unknown[] };
  assert.equal(raw.tickets.length, 0);
});
