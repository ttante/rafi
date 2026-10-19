import { canonicalContractJson } from "./qaVerificationContract.js";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { stringify } from "yaml";
import { ticketPopulationProposalV1Schema, zodIssues, type StructuredPlanV1 } from "rafi-spec";
import { WorkflowDb, WORKFLOW_DB_FILE } from "./workflowDb.js";
import { cmdRender, cmdValidate } from "./tickets/commands.js";
import { loadTickets, RISK_ROLLBACK_REQUIRED, validateTicketDefs } from "./tickets/ticketLoader.js";
import type { TicketDef } from "./tickets/ticketSchema.js";
import { normalizeDeliveryConfig, validateDeliveryConfig, type DeliveryConfig } from "./tickets/delivery.js";
import { loadTicketsConfig, resolveTicketPaths } from "./tickets/config.js";
import { StateDb } from "./tickets/stateDb.js";
import { ticketDefinitionDigest } from "./tickets/riskWaivers.js";

export interface TicketSliceProposal {
  qa_preparation?: TicketDef["qa_preparation"];
  documentation?: TicketDef["documentation"];
  slice_ref: string;
  title: string; area: string; priority: TicketDef["priority"]; size: TicketDef["size"]; risk: TicketDef["risk"];
  summary: string; acceptance: string[]; required_tests: string[]; likely_files: string[];
  depends_on: string[]; rollback?: string | null; notes?: string | null;
  source_refs?: Array<{ source_id: string; fingerprint: string; item?: string; url?: string | null; note?: string | null }>;
}
export interface TicketPopulationProposalV1 { version: 1; plan_id: string; revision: number; tickets: TicketSliceProposal[]; retirements: string[] }
export const TICKET_POPULATION_PROPOSAL_START = "RAFI_TICKET_POPULATION_PROPOSAL_START";
export const TICKET_POPULATION_PROPOSAL_END = "RAFI_TICKET_POPULATION_PROPOSAL_END";
export interface PopulationRiskWaiver { ticketId: string; reason: string; actor: string }
export interface MaterializedTicketPopulation { tickets: TicketDef[]; delivery: DeliveryConfig; retirements: string[]; sliceToTicket: Map<string, string>; riskWaivers?: PopulationRiskWaiver[] }
export type PopulationBranchStrategy = "current" | "batch" | "branch-per-ticket";

function additiveAbsenceRequirement(text: string): boolean {
  return [
    /\bslice alone\b/i,
    /\bwithout\b.*\b(?:present|implemented|enabled)\b/i,
    /\bonly\b.*\bown\b.*\btest files?\b/i,
    /\bonly\b.*\btest files?\b.*\bpresent\b/i,
  ].some((pattern) => pattern.test(text));
}

function additiveIndependenceIssues(
  ticket: TicketSliceProposal,
  plannedSlice: StructuredPlanV1["slices"][number] | undefined,
  currentBranch: boolean,
): string[] {
  if (!currentBranch || !plannedSlice) return [];

  const approvedRequirements = new Set([
    ...plannedSlice.acceptance,
    ...plannedSlice.required_tests,
  ].map((item) => item.trim()));

  return [...ticket.acceptance, ...ticket.required_tests]
    .filter(additiveAbsenceRequirement)
    .filter((item) => !approvedRequirements.has(item.trim()))
    .map(() =>
      `ticket ${ticket.slice_ref} adds a sibling-absence requirement; use positive own-slice checks against the shared baseline`,
    );
}

/** A recoverable, proposal-local validation failure. Callers can ask Ticket Maker
 * to repair only the listed tickets instead of discarding the whole interview. */
export class TicketPopulationValidationError extends Error {
  readonly repairableRiskTicketIds: string[];
  readonly repairableRiskSliceRefs: string[];
  readonly onlyRepairableRiskFailures: boolean;
  constructor(message: string, repairableRiskTicketIds: string[], repairableRiskSliceRefs: string[], onlyRepairableRiskFailures: boolean) {
    super(message);
    this.name = "TicketPopulationValidationError";
    this.repairableRiskTicketIds = repairableRiskTicketIds;
    this.repairableRiskSliceRefs = repairableRiskSliceRefs;
    this.onlyRepairableRiskFailures = onlyRepairableRiskFailures;
  }
}

/** Reject a correction that attempts to turn a risk-note repair into a new plan. */
export function assertRiskPlanOnlyCorrection(
  previous: TicketPopulationProposalV1,
  corrected: TicketPopulationProposalV1,
  permittedSliceRefs: string[],
): void {
  const permitted = new Set(permittedSliceRefs);
  if (previous.version !== corrected.version || previous.plan_id !== corrected.plan_id || previous.revision !== corrected.revision || JSON.stringify(previous.retirements) !== JSON.stringify(corrected.retirements)) {
    throw new Error("Ticket Maker correction changed proposal identity or retirements; only rollback fields may be corrected");
  }
  const before = new Map(previous.tickets.map(ticket => [ticket.slice_ref, ticket]));
  if (before.size !== corrected.tickets.length) throw new Error("Ticket Maker correction changed ticket mappings; only rollback fields may be corrected");
  for (const ticket of corrected.tickets) {
    const original = before.get(ticket.slice_ref);
    if (!original) throw new Error("Ticket Maker correction changed ticket mappings; only rollback fields may be corrected");
    const originalComparable = { ...original, rollback: undefined };
    const correctedComparable = { ...ticket, rollback: undefined };
    if (stableJson(originalComparable) !== stableJson(correctedComparable)) throw new Error(`Ticket Maker correction changed fields other than rollback for ${ticket.slice_ref}`);
    if (!permitted.has(ticket.slice_ref)) {
      if (ticket.rollback !== original.rollback) throw new Error(`Ticket Maker correction changed rollback for unaffected ticket ${ticket.slice_ref}`);
    }
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function extractTicketPopulationProposal(output: string): TicketPopulationProposalV1 {
  const start = output.lastIndexOf(TICKET_POPULATION_PROPOSAL_START); const end = output.lastIndexOf(TICKET_POPULATION_PROPOSAL_END);
  if (start < 0 || end <= start) throw new Error(`ticket-maker output is missing ${TICKET_POPULATION_PROPOSAL_START}/${TICKET_POPULATION_PROPOSAL_END}`);
  const raw = output.slice(start + TICKET_POPULATION_PROPOSAL_START.length, end).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (error) { throw new Error(`ticket-maker proposal is invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  const validated = ticketPopulationProposalV1Schema.safeParse(parsed);
  if (!validated.success) throw new Error(`ticket-maker proposal contract validation failed:\n${zodIssues(validated.error).map((issue) => `- ${issue}`).join("\n")}`);
  return validated.data;
}

export function validateTicketPopulationProposal(proposal: TicketPopulationProposalV1, plan: StructuredPlanV1, existing: TicketDef[], options: { branchStrategy?: PopulationBranchStrategy } = {}): string[] {
  const issues: string[] = [];
  const contract = ticketPopulationProposalV1Schema.safeParse(proposal);
  const contractIssues = contract.success ? [] : zodIssues(contract.error);
  if (proposal.version !== 1 || proposal.plan_id !== plan.plan_id || proposal.revision !== plan.revision) issues.push("proposal plan identity does not match the approved structured plan");
  const planned = new Set(plan.slices.map((slice) => slice.slice_ref)); const mapped = new Set<string>();
  for (const ticket of proposal.tickets) {
    const plannedSlice = plan.slices.find(slice => slice.slice_ref === ticket.slice_ref);
    issues.push(...additiveIndependenceIssues(
      ticket,
      plannedSlice,
      options.branchStrategy !== undefined
        ? options.branchStrategy === "current"
        : plan.slices.length > 1 && plan.delivery_units.some(unit => unit.branch_mode === "current"),
    ));
    const depth = plannedSlice?.qa_preparation;
    if (ticket.qa_preparation && (!depth || canonicalContractJson(ticket.qa_preparation) !== canonicalContractJson(depth))) issues.push(`ticket-maker cannot override planner QA depth for ${ticket.slice_ref}`);
    const documentation = plannedSlice?.documentation ?? { required: false, targets: [], criteria: [] };
    if (ticket.documentation && canonicalContractJson(ticket.documentation) !== canonicalContractJson(documentation)) issues.push(`ticket-maker cannot override planner documentation policy for ${ticket.slice_ref}`);
    if (!planned.has(ticket.slice_ref)) issues.push(`unknown slice mapping ${ticket.slice_ref}`);
    if (mapped.has(ticket.slice_ref)) issues.push(`duplicate slice mapping ${ticket.slice_ref}`); else mapped.add(ticket.slice_ref);
    for (const dep of ticket.depends_on) if (!planned.has(dep)) issues.push(`slice ${ticket.slice_ref} depends on unknown slice ${dep}`);
  }
  for (const ref of planned) if (!mapped.has(ref)) issues.push(`missing ticket mapping for slice ${ref}`);
  const expectedRetirements = existing.filter((ticket) => ticket.plan_ref?.plan_id === plan.plan_id && !planned.has(ticket.plan_ref.slice_ref) && ticket.plan_ref.revision < plan.revision).map((ticket) => ticket.id).sort();
  if (JSON.stringify([...proposal.retirements].sort()) !== JSON.stringify(expectedRetirements)) issues.push(`retirements must exactly match removed populated slices: ${expectedRetirements.join(",") || "none"}`);
  return [...new Set([...contractIssues, ...issues])];
}

export function materializeTicketPopulation(
  proposal: TicketPopulationProposalV1,
  plan: StructuredPlanV1,
  existing: TicketDef[],
  options: { waiveRiskTicketIds?: string[]; waiverReason?: string; waiverActor?: string; branchStrategy?: PopulationBranchStrategy } = {},
): MaterializedTicketPopulation {
  const issues = validateTicketPopulationProposal(proposal, plan, existing, { branchStrategy: options.branchStrategy }); if (issues.length) throw new Error(issues.join("; "));
  const byPlanSlice = new Map(existing.filter((ticket) => ticket.plan_ref).map((ticket) => [`${ticket.plan_ref!.plan_id}:${ticket.plan_ref!.slice_ref}`, ticket]));
  const reserved = new Set(existing.map((ticket) => ticket.id)); const sliceToTicket = new Map<string, string>();
  for (const slice of proposal.tickets) {
    const retained = byPlanSlice.get(`${plan.plan_id}:${slice.slice_ref}`);
    const id = retained?.id ?? allocateTicketId(reserved); reserved.add(id); sliceToTicket.set(slice.slice_ref, id);
  }
  const materialized = proposal.tickets.map((slice, index): TicketDef => {
    const retained = byPlanSlice.get(`${plan.plan_id}:${slice.slice_ref}`);
    return {
      ...(retained ?? {}), qa_preparation: structuredClone(plan.slices.find(item => item.slice_ref === slice.slice_ref)?.qa_preparation), id: sliceToTicket.get(slice.slice_ref)!, order: retained?.order ?? nextOrder(existing, index),
      title: slice.title, area: slice.area, priority: slice.priority, size: slice.size, risk: slice.risk,
      depends_on: slice.depends_on.map((ref) => sliceToTicket.get(ref)!), summary: slice.summary,
      acceptance: [...slice.acceptance], required_tests: [...slice.required_tests], likely_files: [...slice.likely_files],
      documentation: structuredClone(slice.documentation ?? plan.slices.find(item => item.slice_ref === slice.slice_ref)?.documentation ?? { required: false, targets: [], criteria: [] }),
      rollback: slice.rollback, notes: slice.notes, plan_ref: { plan_id: plan.plan_id, revision: plan.revision, slice_ref: slice.slice_ref },
      source_refs: (plan.slices.find((item) => item.slice_ref === slice.slice_ref)?.source_refs ?? slice.source_refs)?.map((ref) => ({
        source: ref.source_id, item: ref.item ?? "document", source_id: ref.source_id, fingerprint: ref.fingerprint,
        ...(ref.url !== undefined ? { url: ref.url } : {}), ...(ref.note !== undefined ? { note: ref.note } : {}),
      })),
    };
  });
  const ownedIds = new Set(materialized.map((ticket) => ticket.id));
  const tickets = [...existing.filter((ticket) => !ownedIds.has(ticket.id)), ...materialized].sort((a, b) => a.order - b.order);
  const branchMode = options.branchStrategy === "current" ? "current" : options.branchStrategy === "batch" ? "shared" : options.branchStrategy === "branch-per-ticket" ? "per-ticket" : undefined;
  const delivery: DeliveryConfig = normalizeDeliveryConfig({
    version: 1, plan: { plan_id: plan.plan_id, revision: plan.revision },
    units: plan.delivery_units.map((unit) => ({
      id: unit.id, tickets: unit.slice_refs.map((ref) => sliceToTicket.get(ref)), branch_mode: branchMode ?? unit.branch_mode,
      completion: options.branchStrategy === "current" ? "none" : unit.completion,
      provider: options.branchStrategy === "current" ? "local" : unit.provider, pr_ready: options.branchStrategy === "current" ? false : unit.pr_ready, merge_method: unit.merge_method,
      cleanup: unit.cleanup, depends_on: unit.depends_on, dependency_mode: unit.dependency_mode,
    })),
    stacks: options.branchStrategy === "current" ? [] : plan.stacks.map((stack) => ({ id: stack.stack_id, name: stack.name, units: stack.units, status: "planned" })),
  });
  const ticketValidation = validateTicketDefs(tickets);
  const deliveryValidation = validateDeliveryConfig(delivery, tickets);
  const validation = [...ticketValidation.map((issue) => `${issue.path}: ${issue.message}`), ...deliveryValidation.map((issue) => `${issue.path}: ${issue.message}`)];
  if (validation.length) {
    const riskTicketIds = ticketValidation
      .filter((issue) => issue.code === RISK_ROLLBACK_REQUIRED)
      .map((issue) => issue.path.match(/^tickets\[([^\]]+)\]/)?.[1])
      .filter((id): id is string => Boolean(id));
    const waiverIds = [...new Set(options.waiveRiskTicketIds ?? [])].sort();
    const allRiskIds = [...new Set(riskTicketIds)].sort();
    const waiverIsExact = JSON.stringify(waiverIds) === JSON.stringify(allRiskIds);
    if (waiverIsExact && allRiskIds.length > 0 && typeof options.waiverReason === "string" && options.waiverReason.trim()) {
      const remaining = validation.filter((issue) => !ticketValidation.some((ticketIssue) => ticketIssue.code === RISK_ROLLBACK_REQUIRED && `${ticketIssue.path}: ${ticketIssue.message}` === issue));
      if (!remaining.length) {
        return {
          tickets, delivery, retirements: [...proposal.retirements], sliceToTicket,
          riskWaivers: allRiskIds.map(ticketId => ({ ticketId, reason: options.waiverReason!.trim(), actor: options.waiverActor?.trim() || "operator" })),
        };
      }
    }
    throw new TicketPopulationValidationError(
      `materialized ticket population is invalid:\n${validation.map((issue) => `- ${issue}`).join("\n")}`,
      riskTicketIds,
      tickets.filter(ticket => riskTicketIds.includes(ticket.id)).map(ticket => ticket.plan_ref?.slice_ref).filter((ref): ref is string => Boolean(ref)),
      riskTicketIds.length > 0 && validation.length === riskTicketIds.length,
    );
  }
  return { tickets, delivery, retirements: [...proposal.retirements], sliceToTicket, riskWaivers: [] };
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
  // Finish any older two-phase publication before resolving a new batch. This
  // makes direct API use as safe as the CLI pre-action hook.
  recoverTicketPublications(root);
  const previousTickets = loadTickets(paths.tickets);
  const previousIds = new Set(previousTickets.map((ticket) => ticket.id));
  const createdTickets = materialized.tickets.filter((ticket) => !previousIds.has(ticket.id));
  const workflow = new WorkflowDb(root); let actualRunId = runId;
  let lease: ReturnType<WorkflowDb["acquireLease"]> | undefined;
  try {
    if (!actualRunId) actualRunId = workflow.createRun({ kind: "ticket-populate", originalWork: { tickets: materialized.tickets.map((ticket) => ticket.id) }, state: {} }, now).runId;
    lease = workflow.acquireLease(actualRunId, undefined, now);
    const operationId = `ticket-populate-publication:${actualRunId}`;
    const deliveryPath = join(root, ".tickets", "delivery.yaml");
    const stage = join(root, ".rafi", "staging", randomUUID()); mkdirSync(stage, { recursive: true });
    const stagedTickets = join(stage, "tickets.yaml"); const stagedDelivery = join(stage, "delivery.yaml");
    const tx = workflow.beginPublication(actualRunId, {
      operation: "ticket-populate", operationId,
      files: [{ staged: stagedTickets, target: paths.tickets }, { staged: stagedDelivery, target: deliveryPath }],
      stage, managedTicketIds: materialized.tickets.map((ticket) => ticket.id),
      approvedDefinitions: materialized.tickets, approvedDelivery: materialized.delivery,
    }, {
      [paths.tickets]: fileDigest(paths.tickets), [deliveryPath]: fileDigest(deliveryPath),
    }, now);
    fsyncWrite(stagedTickets, stringify({ tickets: materialized.tickets }, { lineWidth: 120 }));
    fsyncWrite(stagedDelivery, stringify(materialized.delivery, { lineWidth: 120 }));
    workflow.updatePublication(tx.transactionId, "staged", now);
    const db = new StateDb(paths.stateDb);
    try {
      db.transaction(() => {
        const at = now.toISOString();
        db.ensureSyntheticLegacyGroup(previousTickets as Array<TicketDef & Record<string, unknown>>, now);
        for (const ticket of materialized.tickets) if (!db.getState(ticket.id)) db.upsertState(ticket.id, { status: "planned", updated_by: "rafi tickets populate" }, at);
        for (const waiver of materialized.riskWaivers ?? []) {
          const ticket = materialized.tickets.find((item) => item.id === waiver.ticketId);
          if (!ticket) throw new Error(`risk waiver references unknown materialized ticket ${waiver.ticketId}`);
          db.upsertTicketRiskWaiver({ ticket_id: ticket.id, definition_digest: ticketDefinitionDigest(ticket), reason: waiver.reason, waived_by: waiver.actor, waived_at: at });
        }
        for (const id of materialized.retirements) {
          const prior = db.getState(id); if (prior?.status === "done") continue;
          db.upsertState(id, { status: "obsolete", completed_at: at, updated_by: "rafi tickets populate" }, at);
          db.insertEvent({ timestamp: at, actor: "rafi tickets populate", ticket_id: id, event_type: "obsolete", old_status: prior?.status ?? "planned", new_status: "obsolete", summary: "Removed by approved plan revision", validation: null, evidence: null, payload_json: JSON.stringify({ runId: actualRunId }) });
        }
        if (createdTickets.length) db.createTicketGroup({ origin: "ticket-populate", operationId: `ticket-populate:${actualRunId}`, createdAt: at, members: createdTickets.map((ticket) => ({ ticketId: ticket.id, definition: ticket, validatedAt: at })) });
        db.recordOperationReceipt({
          operation_id: operationId,
          operation_type: "ticket-populate-publication",
          ticket_id: null,
          run_id: actualRunId!,
          completed_at: at,
          payload_json: JSON.stringify({ transactionId: tx.transactionId, tickets: materialized.tickets.map((ticket) => ticket.id), riskWaivers: (materialized.riskWaivers ?? []).map((waiver) => waiver.ticketId) }),
        });
      });
    } finally { db.close(); }
    workflow.updatePublication(tx.transactionId, "tracker_committed", now);
    publishStaged(stagedTickets, paths.tickets); publishStaged(stagedDelivery, deliveryPath);
    workflow.updatePublication(tx.transactionId, "published", now);
    cmdRender(root); const validation = cmdValidate(root); if (!validation.clean) throw new Error(`published ticket population failed validation: ${validation.issues.map((issue) => issue.message).join("; ")}`);
    const snapshotDb = new StateDb(paths.stateDb);
    try { for (const ticket of materialized.tickets) if (snapshotDb.getTicketGroupForTicket(ticket.id)) snapshotDb.updateTicketDefinitionSnapshot(ticket.id, ticket, now.toISOString()); } finally { snapshotDb.close(); }
    workflow.updatePublication(tx.transactionId, "committed", now);
    workflow.transition(actualRunId, { status: "completed", checkpoint: "population-committed", remainingWork: {}, state: { transactionId: tx.transactionId } }, now);
    rmSync(stage, { recursive: true, force: true }); return { runId: actualRunId, transactionId: tx.transactionId };
  } finally { if (lease) workflow.releaseLease(lease, now); workflow.close(); }
}

/** Startup recovery deterministically finishes publications after tracker commit. */
export function recoverTicketPublications(projectDir: string): string[] {
  if (!existsSync(join(resolve(projectDir), WORKFLOW_DB_FILE))) return [];
  const workflow = new WorkflowDb(projectDir); const recovered: string[] = [];
  try {
    for (const tx of workflow.incompletePublications()) {
      const intent = tx.intent as {
        operation?: string;
        operationId?: string;
        files?: Array<{ staged: string; target: string }>;
        stage?: string;
        managedTicketIds?: string[];
      };
      const run = workflow.getRun(tx.runId);
      const isLegacyPopulation = !intent.operation && Array.isArray(intent.files) && run?.kind === "ticket-populate";
      if (intent.operation !== "ticket-populate" && !isLegacyPopulation) continue;
      if (!intent.files || !intent.stage) throw new Error(`ticket population ${tx.transactionId} has an invalid durable publication intent`);

      const root = resolve(projectDir);
      const config = loadTicketsConfig(root);
      const paths = resolveTicketPaths(config, root);
      let trackerCommitted = ["tracker_committed", "published"].includes(tx.status);
      if (!trackerCommitted && intent.operationId) {
        const receiptDb = new StateDb(paths.stateDb);
        try { trackerCommitted = Boolean(receiptDb.getOperationReceipt(intent.operationId)); }
        finally { receiptDb.close(); }
      }

      if (!trackerCommitted) {
        rmSync(intent.stage, { recursive: true, force: true });
        workflow.updatePublication(tx.transactionId, "rolled_back");
        if (run && run.status !== "failed") workflow.transition(run.runId, { status: "failed", checkpoint: "population-rolled-back-before-tracker-commit", state: { ...run.state, recoveredPublication: tx.transactionId } });
        recovered.push(tx.transactionId);
        continue;
      }

      if (tx.status !== "published") {
        for (const file of intent.files) {
          if (!existsSync(file.staged)) throw new Error(`ticket population ${tx.transactionId} cannot recover because staged file is missing: ${file.staged}`);
          publishStaged(file.staged, file.target);
        }
        workflow.updatePublication(tx.transactionId, "published");
      }
      cmdRender(root);
      const validation = cmdValidate(root);
      if (!validation.clean) throw new Error(`recovered ticket population failed validation: ${validation.issues.map((issue) => issue.message).join("; ")}`);
      const definitions = loadTickets(paths.tickets);
      const managedIds = new Set(intent.managedTicketIds ?? definitions.map((ticket) => ticket.id));
      const snapshotDb = new StateDb(paths.stateDb);
      try {
        snapshotDb.transaction(() => {
          for (const ticket of definitions) if (managedIds.has(ticket.id) && snapshotDb.getTicketGroupForTicket(ticket.id)) snapshotDb.updateTicketDefinitionSnapshot(ticket.id, ticket);
        });
      } finally { snapshotDb.close(); }
      workflow.updatePublication(tx.transactionId, "committed");
      if (run && run.status !== "completed") workflow.transition(run.runId, { status: "completed", checkpoint: "population-recovered", remainingWork: {}, state: { ...run.state, recoveredPublication: tx.transactionId } });
      recovered.push(tx.transactionId);
      rmSync(intent.stage, { recursive: true, force: true });
    }
    return recovered;
  } finally { workflow.close(); }
}

function allocateTicketId(reserved: Set<string>): string { let n = 1; while (reserved.has(`T${String(n).padStart(3, "0")}`)) n++; return `T${String(n).padStart(3, "0")}`; }
function nextOrder(existing: TicketDef[], offset: number): number { return Math.max(-1, ...existing.map((ticket) => ticket.order)) + 1 + offset; }
function fileDigest(path: string): string | null { return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null; }
function fsyncWrite(path: string, value: string): void { mkdirSync(dirname(path), { recursive: true }); const fd = openSync(path, "wx", 0o600); try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); } }
function publishStaged(staged: string, target: string): void { mkdirSync(dirname(target), { recursive: true }); const temp = `${target}.${process.pid}.${randomUUID()}.tmp`; copyFileSync(staged, temp); const fd = openSync(temp, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } renameSync(temp, target); }
