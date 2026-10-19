#!/usr/bin/env node
// Deliberately small Codex app-server fixture for the full Rafi onboarding gate.
// It behaves like a provider, not a test-side shortcut: the CLI still performs
// create, plan, ticket materialization, validation, queue selection and start.
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

if (process.argv[2] !== "app-server") {
  console.log("OK");
  process.exit(0);
}

let cwd = process.cwd();
let thread = `rafi-e2e-${process.pid}`;
let lastTicketProposal;
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const delta = { version: 1, decisions: [], constraints: [], discoveries: [], completedActions: ["scripted e2e work"], evidence: [], failures: [], blockers: [], openWork: [], nextAction: "finish" };

function planProposal() {
  return {
    version: 1,
    summary: "Add a small safe feature.",
    assumptions: [],
    implementation_changes: ["Add the feature behind an existing module boundary."],
    acceptance_criteria: ["The feature works."],
    test_plan: ["Run the focused feature test."],
    slices: [
      { local_ref: "S1", title: "Add feature", summary: "Implement the requested feature.", acceptance: ["The feature works."], required_tests: ["Run the focused feature test."], likely_files: ["src/feature.ts"], depends_on: [] },
    ],
    delivery_units: [
      { id: "feature", slice_refs: ["S1"], branch_mode: "current", completion: "none", provider: "local", pr_ready: false, merge_method: "squash", cleanup: false, depends_on: [], dependency_mode: "combine" },
    ],
    stacks: [],
  };
}

function approvedPlanFrom(instruction) {
  const match = instruction.match(/- (.+rafi-plan\.json)/);
  if (!match) throw new Error("ticket maker prompt did not name an approved plan");
  return JSON.parse(fs.readFileSync(match[1].trim(), "utf8"));
}

function ticketProposal(instruction, repaired) {
  const plan = approvedPlanFrom(instruction);
  return {
    version: 1,
    plan_id: plan.plan_id,
    revision: plan.revision,
    tickets: plan.slices.map(slice => ({
      slice_ref: slice.slice_ref,
      title: slice.title,
      area: "feature",
      priority: "P1",
      size: "S",
      risk: "Medium",
      summary: slice.summary,
      acceptance: slice.acceptance,
      required_tests: slice.required_tests,
      likely_files: slice.likely_files,
      depends_on: slice.depends_on,
      rollback: repaired ? "Disable the feature path, restore the previous behavior, and verify the focused test passes." : null,
      notes: null,
    })),
    retirements: [],
  };
}

function responseFor(instruction) {
  const assignedTicket = instruction.match(/Assigned ticket: ([^\s.]+)\./)?.[1] || instruction.match(/Ticket scope: ([^\s.]+)\./)?.[1];
  const ticketMarker = assignedTicket ? `ticket="${assignedTicket}" ` : "";
  if (instruction.includes("HANDOFF_ACCEPTED")) {
    return `HANDOFF_ACCEPTED\nSTEP_STATUS: done | summary="scripted handoff accepted"\nRAFI_CONTINUITY_DELTA: ${JSON.stringify(delta)}`;
  }
  if (instruction.includes("RAFI_PLAN_PROPOSAL_START")) {
    return `RAFI_PLAN_PROPOSAL_START\n${JSON.stringify(planProposal())}\nRAFI_PLAN_PROPOSAL_END\nSTEP_STATUS: plan_complete | summary="scripted plan complete"`;
  }
  if (instruction.includes("Correct the existing ticket population proposal only")) {
    if (!lastTicketProposal) throw new Error("ticket correction arrived without an earlier proposal");
    const corrected = structuredClone(lastTicketProposal);
    for (const ticket of corrected.tickets) ticket.rollback = "Disable the feature path, restore the previous behavior, and verify the focused test passes.";
    return `RAFI_TICKET_POPULATION_PROPOSAL_START\n${JSON.stringify(corrected)}\nRAFI_TICKET_POPULATION_PROPOSAL_END\nSTEP_STATUS: done | summary="scripted rollback repair complete"`;
  }
  if (instruction.includes("RAFI_TICKET_POPULATION_PROPOSAL_START")) {
    lastTicketProposal = ticketProposal(instruction, false);
    return `RAFI_TICKET_POPULATION_PROPOSAL_START\n${JSON.stringify(lastTicketProposal)}\nRAFI_TICKET_POPULATION_PROPOSAL_END\nSTEP_STATUS: done | summary="scripted ticket proposal"`;
  }
  if (/Implement exactly this ticket|You are being run by an automated foreman/.test(instruction)) {
    fs.writeFileSync(path.join(cwd, "implemented.txt"), "scripted implementation\n");
  }
  return `STEP_STATUS: done | ${ticketMarker}summary="scripted work complete"\nRAFI_CONTINUITY_DELTA: ${JSON.stringify(delta)}`;
}

readline.createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const params = request.params || {};
  if (request.method === "thread/start" || request.method === "thread/resume") {
    cwd = params.cwd || cwd;
    thread = params.threadId || thread;
    send({ id: request.id, result: { thread: { id: thread, cwd }, sandbox: { type: params.sandbox === "read-only" ? "readOnly" : "workspaceWrite", networkAccess: false }, approvalPolicy: params.approvalPolicy } });
    return;
  }
  if (request.method === "turn/start") {
    const instruction = (params.input || []).map(item => item.text || "").join("\n");
    const text = responseFor(instruction);
    send({ id: request.id, result: { turn: { id: `turn-${process.pid}` } } });
    send({ method: "thread/tokenUsage/updated", params: { threadId: thread, tokenUsage: { total: { inputTokens: 100, outputTokens: 10, totalTokens: 110 }, last: { totalTokens: 20 }, modelContextWindow: 1000 } } });
    send({ method: "item/completed", params: { threadId: thread, item: { type: "agentMessage", text } } });
    send({ method: "turn/completed", params: { threadId: thread, turn: { id: `turn-${process.pid}`, status: "completed" } } });
    return;
  }
  send({ id: request.id, result: {} });
});
