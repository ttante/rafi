import { createHash, randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { stringify } from "yaml";
import type { StructuredPlanV1 } from "rafi-spec";
import { WorkflowDb } from "./workflowDb.js";
import { cmdRender, cmdValidate } from "./tickets/commands.js";
import { loadTickets, validateTicketDefs } from "./tickets/ticketLoader.js";
import type { TicketDef } from "./tickets/ticketSchema.js";
import { normalizeDeliveryConfig, validateDeliveryConfig, type DeliveryConfig } from "./tickets/delivery.js";
import { loadTicketsConfig, resolveTicketPaths } from "./tickets/config.js";
import { StateDb } from "./tickets/stateDb.js";

export interface TicketSliceProposal {
  slice_ref: string;
  title: string; area: string; priority: TicketDef["priority"]; size: TicketDef["size"]; risk: TicketDef["risk"];
  summary: string; acceptance: string[]; required_tests: string[]; likely_files: string[];
  depends_on: string[]; rollback?: string | null; notes?: string | null;
}
export interface TicketPopulationProposalV1 { version: 1; plan_id: string; revision: number; tickets: TicketSliceProposal[]; retirements: string[] }
export const TICKET_POPULATION_PROPOSAL_START = "RAFI_TICKET_POPULATION_PROPOSAL_START";
export const TICKET_POPULATION_PROPOSAL_END = "RAFI_TICKET_POPULATION_PROPOSAL_END";
export interface MaterializedTicketPopulation { tickets: TicketDef[]; delivery: DeliveryConfig; retirements: string[]; sliceToTicket: Map<string, string> }

export function extractTicketPopulationProposal(output: string): TicketPopulationProposalV1 {
  const start = output.lastIndexOf(TICKET_POPULATION_PROPOSAL_START); const end = output.lastIndexOf(TICKET_POPULATION_PROPOSAL_END);
  if (start < 0 || end <= start) throw new Error(`ticket-maker output is missing ${TICKET_POPULATION_PROPOSAL_START}/${TICKET_POPULATION_PROPOSAL_END}`);
  const raw = output.slice(start + TICKET_POPULATION_PROPOSAL_START.length, end).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(raw) as TicketPopulationProposalV1; } catch (error) { throw new Error(`ticket-maker proposal is invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

export function validateTicketPopulationProposal(proposal: TicketPopulationProposalV1, plan: StructuredPlanV1, existing: TicketDef[]): string[] {
  const issues: string[] = [];
  if (proposal.version !== 1 || proposal.plan_id !== plan.plan_id || proposal.revision !== plan.revision) issues.push("proposal plan identity does not match the approved structured plan");
  const planned = new Set(plan.slices.map((slice) => slice.slice_ref)); const mapped = new Set<string>();
  for (const ticket of proposal.tickets) {
    if (!planned.has(ticket.slice_ref)) issues.push(`unknown slice mapping ${ticket.slice_ref}`);
    if (mapped.has(ticket.slice_ref)) issues.push(`duplicate slice mapping ${ticket.slice_ref}`); else mapped.add(ticket.slice_ref);
    for (const dep of ticket.depends_on) if (!planned.has(dep)) issues.push(`slice ${ticket.slice_ref} depends on unknown slice ${dep}`);
  }
  for (const ref of planned) if (!mapped.has(ref)) issues.push(`missing ticket mapping for slice ${ref}`);
  const expectedRetirements = existing.filter((ticket) => ticket.plan_ref?.plan_id === plan.plan_id && !planned.has(ticket.plan_ref.slice_ref) && ticket.plan_ref.revision < plan.revision).map((ticket) => ticket.id).sort();
  if (JSON.stringify([...proposal.retirements].sort()) !== JSON.stringify(expectedRetirements)) issues.push(`retirements must exactly match removed populated slices: ${expectedRetirements.join(",") || "none"}`);
  return issues;
}

export function materializeTicketPopulation(proposal: TicketPopulationProposalV1, plan: StructuredPlanV1, existing: TicketDef[]): MaterializedTicketPopulation {
  const issues = validateTicketPopulationProposal(proposal, plan, existing); if (issues.length) throw new Error(issues.join("; "));
  const byPlanSlice = new Map(existing.filter((ticket) => ticket.plan_ref).map((ticket) => [`${ticket.plan_ref!.plan_id}:${ticket.plan_ref!.slice_ref}`, ticket]));
  const reserved = new Set(existing.map((ticket) => ticket.id)); const sliceToTicket = new Map<string, string>();
  for (const slice of proposal.tickets) {
    const retained = byPlanSlice.get(`${plan.plan_id}:${slice.slice_ref}`);
    const id = retained?.id ?? allocateTicketId(reserved); reserved.add(id); sliceToTicket.set(slice.slice_ref, id);
  }
  const materialized = proposal.tickets.map((slice, index): TicketDef => {
    const retained = byPlanSlice.get(`${plan.plan_id}:${slice.slice_ref}`);
    return {
      ...(retained ?? {}), id: sliceToTicket.get(slice.slice_ref)!, order: retained?.order ?? nextOrder(existing, index),
      title: slice.title, area: slice.area, priority: slice.priority, size: slice.size, risk: slice.risk,
      depends_on: slice.depends_on.map((ref) => sliceToTicket.get(ref)!), summary: slice.summary,
      acceptance: [...slice.acceptance], required_tests: [...slice.required_tests], likely_files: [...slice.likely_files],
      rollback: slice.rollback, notes: slice.notes, plan_ref: { plan_id: plan.plan_id, revision: plan.revision, slice_ref: slice.slice_ref },
    };
  });
  const ownedIds = new Set(materialized.map((ticket) => ticket.id));
  const tickets = [...existing.filter((ticket) => !ownedIds.has(ticket.id)), ...materialized].sort((a, b) => a.order - b.order);
  const delivery: DeliveryConfig = normalizeDeliveryConfig({
    version: 1, plan: { plan_id: plan.plan_id, revision: plan.revision },
    units: plan.delivery_units.map((unit) => ({
      id: unit.id, tickets: unit.slice_refs.map((ref) => sliceToTicket.get(ref)), branch_mode: unit.branch_mode,
      completion: unit.completion, provider: unit.provider, pr_ready: unit.pr_ready, merge_method: unit.merge_method,
      cleanup: unit.cleanup, depends_on: unit.depends_on, dependency_mode: unit.dependency_mode,
    })),
    stacks: plan.stacks.map((stack) => ({ id: stack.stack_id, name: stack.name, units: stack.units, status: "planned" })),
  });
  const validation = [...validateTicketDefs(tickets).map((issue) => `${issue.path}: ${issue.message}`), ...validateDeliveryConfig(delivery, tickets).map((issue) => `${issue.path}: ${issue.message}`)];
  if (validation.length) throw new Error(`materialized ticket population is invalid:\n${validation.map((issue) => `- ${issue}`).join("\n")}`);
  return { tickets, delivery, retirements: [...proposal.retirements], sliceToTicket };
}

export function authorizeTicketRetirements(retirements: string[], input: { interactiveConfirmed?: boolean; authorizedIds?: string[]; computerRun?: boolean }): void {
  if (!retirements.length) return;
  if (input.computerRun) {
    const authorized = [...(input.authorizedIds ?? [])].sort();
    if (JSON.stringify(authorized) !== JSON.stringify([...retirements].sort())) throw new Error(`computer-run retirement requires exact authorized ticket IDs: ${retirements.join(",")}`);
  } else if (!input.interactiveConfirmed) throw new Error(`retirement confirmation required for: ${retirements.join(",")}`);
}

export function applyTicketPopulation(projectDir: string, materialized: MaterializedTicketPopulation, runId?: string, now = new Date()): { runId: string; transactionId: string } {
  const root = resolve(projectDir); const config = loadTicketsConfig(root); const paths = resolveTicketPaths(config, root);
  const workflow = new WorkflowDb(root); let actualRunId = runId;
  let lease: ReturnType<WorkflowDb["acquireLease"]> | undefined;
  try {
    if (!actualRunId) actualRunId = workflow.createRun({ kind: "ticket-populate", originalWork: { tickets: materialized.tickets.map((ticket) => ticket.id) }, state: {} }, now).runId;
    lease = workflow.acquireLease(actualRunId, undefined, now);
    const deliveryPath = join(root, ".tickets", "delivery.yaml");
    const stage = join(root, ".rafi", "staging", randomUUID()); mkdirSync(stage, { recursive: true });
    const stagedTickets = join(stage, "tickets.yaml"); const stagedDelivery = join(stage, "delivery.yaml");
    const tx = workflow.beginPublication(actualRunId, { files: [{ staged: stagedTickets, target: paths.tickets }, { staged: stagedDelivery, target: deliveryPath }], stage }, {
      [paths.tickets]: fileDigest(paths.tickets), [deliveryPath]: fileDigest(deliveryPath),
    }, now);
    fsyncWrite(stagedTickets, stringify({ tickets: materialized.tickets }, { lineWidth: 120 }));
    fsyncWrite(stagedDelivery, stringify(materialized.delivery, { lineWidth: 120 }));
    workflow.updatePublication(tx.transactionId, "staged", now);
    const db = new StateDb(paths.stateDb);
    try {
      db.transaction(() => {
        const at = now.toISOString();
        for (const ticket of materialized.tickets) if (!db.getState(ticket.id)) db.upsertState(ticket.id, { status: "planned", updated_by: "rafi tickets populate" }, at);
        for (const id of materialized.retirements) {
          const prior = db.getState(id); if (prior?.status === "done") continue;
          db.upsertState(id, { status: "obsolete", completed_at: at, updated_by: "rafi tickets populate" }, at);
          db.insertEvent({ timestamp: at, actor: "rafi tickets populate", ticket_id: id, event_type: "obsolete", old_status: prior?.status ?? "planned", new_status: "obsolete", summary: "Removed by approved plan revision", validation: null, evidence: null, payload_json: JSON.stringify({ runId: actualRunId }) });
        }
      });
    } finally { db.close(); }
    workflow.updatePublication(tx.transactionId, "tracker_committed", now);
    publishStaged(stagedTickets, paths.tickets); publishStaged(stagedDelivery, deliveryPath);
    workflow.updatePublication(tx.transactionId, "published", now);
    cmdRender(root); const validation = cmdValidate(root); if (!validation.clean) throw new Error(`published ticket population failed validation: ${validation.issues.map((issue) => issue.message).join("; ")}`);
    workflow.updatePublication(tx.transactionId, "committed", now);
    workflow.transition(actualRunId, { status: "completed", checkpoint: "population-committed", remainingWork: {}, state: { transactionId: tx.transactionId } }, now);
    rmSync(stage, { recursive: true, force: true }); return { runId: actualRunId, transactionId: tx.transactionId };
  } finally { if (lease) workflow.releaseLease(lease, now); workflow.close(); }
}

/** Startup recovery deterministically finishes publications after tracker commit. */
export function recoverTicketPublications(projectDir: string): string[] {
  const workflow = new WorkflowDb(projectDir); const recovered: string[] = [];
  try {
    for (const tx of workflow.incompletePublications()) {
      const intent = tx.intent as { files: Array<{ staged: string; target: string }>; stage: string };
      if (["tracker_committed", "published"].includes(tx.status)) {
        if (tx.status === "tracker_committed") for (const file of intent.files) if (existsSync(file.staged)) publishStaged(file.staged, file.target);
        workflow.updatePublication(tx.transactionId, "committed"); recovered.push(tx.transactionId); rmSync(intent.stage, { recursive: true, force: true });
      } else {
        rmSync(intent.stage, { recursive: true, force: true }); workflow.updatePublication(tx.transactionId, "rolled_back"); recovered.push(tx.transactionId);
      }
    }
    return recovered;
  } finally { workflow.close(); }
}

function allocateTicketId(reserved: Set<string>): string { let n = 1; while (reserved.has(`T${String(n).padStart(3, "0")}`)) n++; return `T${String(n).padStart(3, "0")}`; }
function nextOrder(existing: TicketDef[], offset: number): number { return Math.max(-1, ...existing.map((ticket) => ticket.order)) + 1 + offset; }
function fileDigest(path: string): string | null { return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null; }
function fsyncWrite(path: string, value: string): void { mkdirSync(dirname(path), { recursive: true }); const fd = openSync(path, "wx", 0o600); try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); } }
function publishStaged(staged: string, target: string): void { mkdirSync(dirname(target), { recursive: true }); const temp = `${target}.${process.pid}.${randomUUID()}.tmp`; copyFileSync(staged, temp); const fd = openSync(temp, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } renameSync(temp, target); }
