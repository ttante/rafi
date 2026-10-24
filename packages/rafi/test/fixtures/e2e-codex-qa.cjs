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
let turnSequence = 0;
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const delta = { version: 1, decisions: [], constraints: [], discoveries: [], completedActions: ["scripted e2e work"], evidence: [], failures: [], blockers: [], openWork: [], nextAction: "finish" };
const obligations = ["behavior-mapping", "prerequisites", "scope-boundaries", "implementation-inspection", "test-inspection", "edge-cases", "verification-sequence"];
const envelope = (tag, value) => `${tag}_START\n${JSON.stringify(value)}\n${tag}_END\nRAFI_CONTINUITY_DELTA: ${JSON.stringify(delta)}`;
function jsonAfter(text, marker) {
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`Missing prompt marker ${marker}`);
  const rest = text.slice(start + marker.length).trimStart();
  let inString = false, escaped = false, depth = 0;
  for (let i = 0; i < rest.length; i++) {
    const char = rest[i];
    if (inString) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') inString = false; continue; }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") { depth--; if (!depth) return JSON.parse(rest.slice(0, i + 1)); }
  }
  throw new Error(`Incomplete JSON after ${marker}`);
}

function planProposal() {
  return {
    version: 1,
    summary: "Add a small safe feature.",
    assumptions: [],
    implementation_changes: ["Add the feature behind an existing module boundary."],
    acceptance_criteria: ["The feature works."],
    test_plan: ["Run the focused feature test."],
    slices: [
      { local_ref: "S1", title: "Add feature", summary: "Implement the requested feature.", acceptance: ["The feature works."], required_tests: ["Run the focused feature test."], likely_files: ["src/feature.ts"], depends_on: [], qa_preparation: { version: 1, decisionId: "scripted-depth", level: 2, rationale: "Ordinary bounded fixture change", riskFactors: [], policyVersion: "qa-preparation-v1", plannerOperationId: "scripted-planner", plannerIdentity: "scripted-planner", timestamp: "2026-01-01T00:00:00Z", minimumLevel: 2, minimumReasons: [] } },
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


// Encode canonical fixture data using the exact provider schema selected by Rafi.
function wire(schema, value, root = schema) {
  if (schema.$ref) return wire(schema.$ref.slice(2).split("/").reduce((node, key) => node[key.replaceAll("~1", "/").replaceAll("~0", "~")], root), value, root);
  const branches = schema.anyOf || schema.oneOf;
  if (branches) {
    const branch = branches.find(b => b.type === "null" ? value === null : value !== null && (b.type !== "object" || typeof value === "object" && !Array.isArray(value) && Object.entries(b.properties || {}).every(([key, f]) => f.const === undefined && !f.enum || f.const === value[key] || f.enum?.includes(value[key]))) && (!b.enum || b.enum.includes(value)));
    return branch ? wire(branch, value, root) : value;
  }
  if (schema.type === "object" && schema.properties && value && typeof value === "object") return Object.fromEntries(Object.entries(schema.properties).map(([key, child]) => [key, value[key] === undefined ? null : wire(child, value[key], root)]));
  if (Array.isArray(value) && schema.items) return value.map(item => wire(schema.items, item, root));
  return value;
}
function responseFor(instruction, schema) {
  if (!schema) return "Ready";
  const operation = schema.properties.operation.const;
  let payload;
  if (operation === "structured-plan") payload = planProposal();
  else if (operation === "ticket-population" || operation === "ticket-population-page") {
    if (instruction.includes("Correct the existing ticket population proposal only")) {
      if (!lastTicketProposal) throw new Error("Correction without a prior proposal");
      payload = structuredClone(lastTicketProposal);
      for (const ticket of payload.tickets) ticket.rollback = "Disable the feature path, restore the previous behavior, and verify the focused test passes.";
    } else payload = lastTicketProposal = ticketProposal(instruction, false);
  } else if (operation === "qa-preparation-depth") payload = { version: 1, decisionId: "scripted-depth", level: 2, rationale: "Ordinary bounded fixture change", riskFactors: [], policyVersion: "qa-preparation-v1", timestamp: "2026-01-01T00:00:00Z", minimumLevel: 2, minimumReasons: [] };
  else if (operation === "qa-preparation-draft") {
    const initial = jsonAfter(instruction, "Authoritative candidate/input inventory:\n");
    const checks = initial.requirements.map((r, index) => ({ id: `proposed-${index}`, requirementRefs: [r.id], origin: "explicit", expectedBehavior: r.statement, obligation: "mandatory", timing: "postimplementation", applicability: { kind: "unconditional", decisionOwner: "qa", requiredEvidence: [] }, verification: [{ kind: "procedure", steps: ["Inspect the fixture implementation and its test"], cwd: ".", fixtures: [], expectedOutcome: "The requirement is satisfied", runtime: "inspection", timeoutMs: 30000 }], expectedEvidence: ["Inspection result"], prerequisiteRefs: [], dependsOnChecks: [] }));
    payload = { kind: "draft", checks, coverage: initial.requirements.map((r, index) => ({ requirementId: r.id, checkIds: [`proposed-${index}`] })), baseline: [], preparationEvidence: obligations.map(obligation => ({ obligation, references: [{ path: process.env.RAFI_E2E_BAD_QA ? "not-an-existing-file" : "README.md", locator: "fixture description" }], analysis: `Inspected fixture for ${obligation}` })), unresolved: [] };
  } else if (operation === "qa-preparation-assessment") {
    const draft = jsonAfter(instruction, "\nDraft:\n");
    payload = { version: 1, assessedRequirementIds: draft.requirements.map(r => r.id), assessedObligations: obligations, concerns: [] };
  } else if (operation === "builder-coverage") payload = { checks: jsonAfter(instruction, "All checks: ").map(check => ({ checkId: check.id, applicability: "applicable", predicateEvidence: [], outcome: "not-run", evidence: [] })) };
  else if (operation === "session-initialization") payload = { ready: true };
  else if (operation === "handoff-acceptance") {
    const match = /Acknowledge manifestDigest ([a-f0-9]+), generation (\d+)/.exec(instruction);
    payload = { manifestDigest: match[1], generation: Number(match[2]), missingResources: [] };
  } else if (operation === "build-preflight") payload = { steps: [{ ticket: null, work: "Implement approved fixture" }] };
  else if (operation === "branch-dependency-audit") payload = { dependencies: [] };
  else if (operation === "work-report") {
    fs.writeFileSync(path.join(cwd, "implemented.txt"), "scripted implementation\n");
    payload = { disposition: "modified", evidence: ["implemented.txt"], coverage: null, graphMaintenance: null };
  } else throw new Error(`Fixture has no native response for ${operation}`);
  if (operation === "ticket-population-page") { const { version: _version, ...page } = payload; payload = { ...page, terminal: true }; }
  return JSON.stringify(wire(schema, { version: 1, operation, result: { kind: "completed", summary: "Scripted fixture completed", payload }, continuity: delta }));
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
    const text = responseFor(instruction, params.outputSchema);
    const turnId = `turn-${process.pid}-${++turnSequence}`;
    send({ id: request.id, result: { turn: { id: turnId } } });
    send({ method: "thread/tokenUsage/updated", params: { threadId: thread, tokenUsage: { total: { inputTokens: 100, outputTokens: 10, totalTokens: 110 }, last: { totalTokens: 20 }, modelContextWindow: 1000 } } });
    send({ method: "item/completed", params: { threadId: thread, turnId, item: { type: "agentMessage", id: `item-${turnId}`, phase: "final_answer", text } } });
    send({ method: "turn/completed", params: { threadId: thread, turn: { id: turnId, status: "completed" } } });
    return;
  }
  send({ id: request.id, result: {} });
});
