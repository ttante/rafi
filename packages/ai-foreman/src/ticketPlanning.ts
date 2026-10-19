import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { loadTicketsConfig, resolveTicketPaths, validateDocsRoot } from "./tickets/config.js";
import { loadTickets, validateTicketDefs } from "./tickets/ticketLoader.js";
import type { TicketDef } from "./tickets/ticketSchema.js";
import { StateDb, type TicketStatus } from "./tickets/stateDb.js";
import { detectCycles } from "./tickets/ticketLoader.js";
import { renderAndWrite } from "./tickets/renderMarkdown.js";
import { runAllValidation } from "./tickets/validate.js";
import { normalizeDeliveryConfig, validateDeliveryConfig, type DeliveryConfig } from "./tickets/delivery.js";
import { loadTicketSetupConfig, mergeTicketSetup, saveTicketSetupConfig, type TicketBuildSetupConfig } from "./tickets/setupConfig.js";
import { z } from "zod";
import { documentationPolicyV1ZodSchema as documentationPolicyZodSchema, qaPreparationDepthDecisionZodSchema, zodIssues } from "rafi-spec";

export const PROPOSAL_START = "RAFI_PROPOSAL_START";
export const PROPOSAL_END = "RAFI_PROPOSAL_END";

export interface TicketEdit { id: string; patch: Partial<Omit<TicketDef, "id">>; }
export interface TicketSupersession { replaced: string[]; replacements: string[]; reason: string; }
export interface TicketStateChange { id: string; status: TicketStatus; reason: string; }
export interface SourceReconciliation {
  source: string;
  item: string;
  disposition: "mapped" | "split" | "combined" | "deferred" | "excluded";
  ticket_ids: string[];
  reason?: string;
}
export interface FutureWorkDisposition { id: number; disposition: "accepted" | "rejected" | "merged" | "queued"; }

export interface TicketPlanProposal {
  version: 1;
  title: string;
  markdown: string;
  additions: TicketDef[];
  edits: TicketEdit[];
  supersessions: TicketSupersession[];
  state_changes: TicketStateChange[];
  source_reconciliation: SourceReconciliation[];
  delivery?: DeliveryConfig | null;
  build_defaults?: Partial<TicketBuildSetupConfig> | null;
  future_work: FutureWorkDisposition[];
  next: { ticket_ids: string[]; replace_existing: boolean };
}

export interface PlanningFingerprint { path: string; sha256: string | null; }

export interface TicketPlanningContext {
  tickets: TicketDef[];
  states: Array<{ ticket_id: string; status: TicketStatus }>;
  futureWork: Array<{ id?: number; summary: string; disposition: string; rationale: string | null }>;
  existingNext: string[];
}

/** The tracker facts needed to validate a proposal before it is approved. */
export interface TicketPlanValidationContext {
  futureWorkIds?: Iterable<number>;
}

const providerText = (max = 20_000) => z.string().trim().min(1).max(max);
const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9-_]{0,127}$/);
const ticketSourceRef = z.strictObject({ source: providerText(500), item: providerText(2_000), source_id: identifier.optional(), url: z.string().url().nullable().optional(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(), note: providerText(2_000).nullable().optional() });
const ticketDefinitionProposal = z.strictObject({
  qa_preparation: qaPreparationDepthDecisionZodSchema.optional(), id: identifier, order: z.number().int().min(0),
  documentation: documentationPolicyZodSchema.optional(),
  title: providerText(500), area: providerText(500), priority: z.enum(["P0", "P1", "P2", "P3"]), size: z.enum(["XS", "S", "M", "L", "XL"]), risk: z.enum(["Low", "Medium", "High"]),
  depends_on: z.array(identifier).max(200), summary: providerText(), acceptance: z.array(providerText()).min(1).max(200), required_tests: z.array(providerText()).min(1).max(200), likely_files: z.array(providerText(1_000)).max(200),
  rollback: z.string().max(20_000).nullable().optional(), notes: z.string().max(20_000).nullable().optional(),
  external_refs: z.array(z.strictObject({ provider: providerText(100), id: providerText(500), key: providerText(500).nullable().optional(), url: z.string().url().nullable().optional() })).max(100).optional(),
  source_refs: z.array(ticketSourceRef).max(100).optional(), superseded_by: z.array(identifier).max(200).optional(), supersedes: z.array(identifier).max(200).optional(),
  plan_ref: z.strictObject({ plan_id: identifier, revision: z.number().int().min(1), slice_ref: identifier }).optional(),
});
const deliveryConfigProposal = z.strictObject({
  version: z.literal(1), plan: z.strictObject({ plan_id: identifier, revision: z.number().int().min(1) }).optional(),
  units: z.array(z.strictObject({ id: identifier, tickets: z.array(identifier).min(1).max(200), branch_mode: z.enum(["current", "per-ticket", "shared"]), completion: z.enum(["pr", "auto-merge", "direct-merge", "none"]).optional(), provider: z.enum(["auto", "github", "gitlab", "local"]).optional(), pr_ready: z.boolean().optional(), merge_method: z.enum(["squash", "merge", "rebase"]).optional(), cleanup: z.boolean().optional(), depends_on: z.array(identifier).max(200).optional(), dependency_mode: z.enum(["combine", "wait", "stack"]).optional() })).max(200),
  stacks: z.array(z.strictObject({ id: identifier, name: providerText(500), units: z.array(identifier).min(1).max(5), status: z.enum(["planned", "in_progress", "partial", "blocked", "awaiting_review", "merged"]).optional(), completed_prefix: z.array(identifier).max(5).optional(), next_ticket: identifier.optional(), review_links: z.array(z.string().url()).max(20).optional(), remote_checked_at: z.string().datetime().optional(), remote_stale: z.boolean().optional(), published_branches: z.record(identifier, providerText(500)).optional() })).max(200).optional(),
});
const buildDefaultsProposal = z.strictObject({
  branch_strategy: z.enum(["current", "batch", "branch-per-ticket"]).optional(), completion: z.enum(["pr", "auto-merge", "direct-merge", "none"]).optional(), provider: z.enum(["auto", "github", "gitlab", "local"]).optional(), pr_ready: z.boolean().optional(), merge_method: z.enum(["squash", "merge", "rebase"]).optional(), cleanup: z.boolean().optional(), auto_merge_wait: z.boolean().optional(), auto_merge_timeout_minutes: z.number().int().min(0).nullable().optional(), base_branch: providerText(500).optional(), branch_prefix: providerText(500).optional(), branch_policy: z.strictObject({ mode: z.enum(["global", "size"]), global_strategy: z.enum(["current", "batch", "branch-per-ticket"]), by_size: z.strictObject({ XS: z.enum(["shared", "per-ticket"]), S: z.enum(["shared", "per-ticket"]), M: z.enum(["shared", "per-ticket"]), L: z.enum(["shared", "per-ticket"]), XL: z.enum(["shared", "per-ticket"]) }) }).optional(), review: z.strictObject({ title_style: z.enum(["ticket-title", "conventional", "none", "custom"]), title_template: z.string().max(500).nullable(), description_sections: z.array(providerText(500)).max(50) }).optional(), validation_checklist: z.array(providerText(500)).max(100).optional(),
});
export const ticketPlanProposalV1Schema = z.strictObject({
  version: z.literal(1), title: providerText(500), markdown: providerText(100_000), additions: z.array(ticketDefinitionProposal).max(200), edits: z.array(z.strictObject({ id: identifier, patch: ticketDefinitionProposal.partial() })).max(200), supersessions: z.array(z.strictObject({ replaced: z.array(identifier).min(1).max(200), replacements: z.array(identifier).min(1).max(200), reason: providerText() })).max(200), state_changes: z.array(z.strictObject({ id: identifier, status: z.enum(["planned", "next", "in_progress", "blocked", "done", "canceled", "obsolete"]), reason: providerText() })).max(200), source_reconciliation: z.array(z.strictObject({ source: providerText(500), item: providerText(2_000), disposition: z.enum(["mapped", "split", "combined", "deferred", "excluded"]), ticket_ids: z.array(identifier).max(200), reason: providerText().optional() })).max(500), delivery: deliveryConfigProposal.nullable().optional(), build_defaults: buildDefaultsProposal.partial().nullable().optional(), future_work: z.array(z.strictObject({ id: z.number().int().min(0), disposition: z.enum(["accepted", "rejected", "merged", "queued"]) })).max(500), next: z.strictObject({ ticket_ids: z.array(identifier).max(200), replace_existing: z.boolean() }),
});

const TICKET_STATUSES = new Set<TicketStatus>([
  "planned", "next", "in_progress", "blocked", "done", "canceled", "obsolete",
]);

export function readTicketPlanningContext(projectDir: string): TicketPlanningContext {
  const config = loadTicketsConfig(projectDir);
  const paths = resolveTicketPaths(config, projectDir);
  const tickets = loadTickets(paths.tickets);
  if (tickets.length > 0 && !existsSync(paths.stateDb)) throw new Error("tickets exist but the ignored ticket-state database is missing; restore it before planning so completed work is not treated as new");
  const db = new StateDb(paths.stateDb);
  try {
    const states = [...db.getAllStates().values()].map(({ ticket_id, status }) => ({ ticket_id, status }));
    return {
      tickets,
      states,
      futureWork: db.getFutureWork().map(({ id, summary, disposition, rationale }) => ({ id, summary, disposition, rationale })),
      existingNext: states.filter((state) => state.status === "next").map((state) => state.ticket_id),
    };
  } finally { db.close(); }
}

export function ticketPlanningFingerprint(projectDir: string): PlanningFingerprint[] {
  const config = loadTicketsConfig(projectDir);
  const paths = resolveTicketPaths(config, projectDir);
  return ["rafi-config.yaml", relative(projectDir, paths.tickets), relative(projectDir, paths.stateDb), `${relative(projectDir, paths.stateDb)}-wal`, `${relative(projectDir, paths.stateDb)}-shm`, ".tickets/delivery.yaml"]
    .map((path) => ({ path, sha256: fileHash(join(projectDir, path)) }));
}

export function planningFingerprintChanges(projectDir: string, expected: PlanningFingerprint[]): string[] {
  return expected.filter((item) => fileHash(join(projectDir, item.path)) !== item.sha256).map((item) => item.path);
}

export function extractTicketPlanProposal(output: string, existingTickets: TicketDef[] = [], context: TicketPlanValidationContext = {}): TicketPlanProposal {
  const start = output.lastIndexOf(PROPOSAL_START);
  const end = output.lastIndexOf(PROPOSAL_END);
  if (start < 0 || end <= start) throw new Error(`planner output is missing ${PROPOSAL_START}/${PROPOSAL_END}`);
  const raw = output.slice(start + PROPOSAL_START.length, end).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (err) { throw new Error(`planner proposal is not valid JSON: ${err instanceof Error ? err.message : String(err)}`); }
  const contract = ticketPlanProposalV1Schema.safeParse(parsed);
  if (!contract.success) throw new Error(`planner proposal contract validation failed:\n${zodIssues(contract.error).map((issue) => `- ${issue}`).join("\n")}`);
  const issues = validateTicketPlanProposal(contract.data, existingTickets, context);
  if (issues.length) throw new Error(`invalid planner proposal:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
  return contract.data;
}

export function validateTicketPlanProposal(value: unknown, existingTickets: TicketDef[] = [], context: TicketPlanValidationContext = {}): string[] {
  const issues: string[] = [];
  const contract = ticketPlanProposalV1Schema.safeParse(value);
  const contractIssues = contract.success ? [] : zodIssues(contract.error);
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["proposal must be an object"];
  const proposal = value as Record<string, unknown>;
  if (proposal.version !== 1) issues.push("version must be 1");
  for (const field of ["title", "markdown"] as const) if (typeof proposal[field] !== "string" || !proposal[field]) issues.push(`${field} must be a non-empty string`);
  for (const field of ["additions", "edits", "supersessions", "state_changes", "source_reconciliation", "future_work"] as const) if (!Array.isArray(proposal[field])) issues.push(`${field} must be an array`);
  if (!proposal.next || typeof proposal.next !== "object" || Array.isArray(proposal.next)) issues.push("next must be an object");
  if (issues.length) return issues;

  const p = proposal as unknown as TicketPlanProposal;
  const staged = [...existingTickets];
  const knownExisting = new Set(existingTickets.map((ticket) => ticket.id));
  for (const addition of p.additions) {
    if (!addition || typeof addition !== "object") { issues.push("addition must be a ticket object"); continue; }
    if (knownExisting.has(addition.id) || staged.some((ticket) => ticket.id === addition.id)) issues.push(`addition reuses ticket ID ${addition.id}`);
    staged.push(addition);
  }
  for (const edit of p.edits) {
    if (!edit || typeof edit.id !== "string" || !edit.patch || typeof edit.patch !== "object" || Array.isArray(edit.patch)) { issues.push("edit must contain id and patch"); continue; }
    if (!staged.some((ticket) => ticket.id === edit.id)) issues.push(`edit references unknown ticket ${edit.id}`);
    if ("id" in edit.patch) issues.push(`edit ${edit.id} cannot change a stable ticket ID`);
    const index = staged.findIndex((ticket) => ticket.id === edit.id);
    if (index >= 0) staged[index] = { ...staged[index]!, ...edit.patch, id: edit.id };
  }
  const ids = new Set(staged.map((ticket) => ticket.id));
  for (const link of p.supersessions) {
    if (!link.reason?.trim() || !link.replaced?.length || !link.replacements?.length) issues.push("each supersession needs replaced, replacements, and reason");
    for (const id of [...(link.replaced ?? []), ...(link.replacements ?? [])]) if (!ids.has(id)) issues.push(`supersession references unknown ticket ${id}`);
  }
  for (const change of p.state_changes) {
    if (!change || typeof change !== "object" || !ids.has(change.id) || !change.reason?.trim()) {
      issues.push(`invalid state change for ${String(change && typeof change === "object" ? change.id : undefined)}`);
      continue;
    }
    if (!TICKET_STATUSES.has(change.status)) issues.push(`state change for ${change.id} has invalid status ${String(change.status)}`);
  }
  const futureWorkIds = context.futureWorkIds ? new Set(context.futureWorkIds) : undefined;
  for (const disposition of p.future_work) {
    if (!disposition || typeof disposition !== "object" || !Number.isInteger(disposition.id)) {
      issues.push(`future work disposition has invalid id ${String(disposition && typeof disposition === "object" ? disposition.id : undefined)}`);
      continue;
    }
    if (!(["accepted", "rejected", "merged", "queued"] as const).includes(disposition.disposition)) {
      issues.push(`future work item ${disposition.id} has invalid disposition ${String(disposition.disposition)}`);
    }
    if (futureWorkIds && !futureWorkIds.has(disposition.id)) issues.push(`future work item ${disposition.id} does not exist`);
  }
  for (const item of p.source_reconciliation) {
    if (!item.source?.trim() || !item.item?.trim()) issues.push("source reconciliation needs source and item");
    if ((item.disposition === "deferred" || item.disposition === "excluded") && !item.reason?.trim()) issues.push(`${item.source}:${item.item} ${item.disposition} needs a reason`);
    for (const id of item.ticket_ids ?? []) if (!ids.has(id)) issues.push(`source reconciliation references unknown ticket ${id}`);
    if (["mapped", "split", "combined"].includes(item.disposition)) {
      for (const id of item.ticket_ids ?? []) {
        const ticket = staged.find((candidate) => candidate.id === id);
        if (ticket && !(ticket.source_refs ?? []).some((ref) => ref.source === item.source && ref.item === item.item)) {
          issues.push(`ticket ${id} is missing source_refs provenance for ${item.source}:${item.item}`);
        }
      }
    }
  }
  if (!Array.isArray(p.next.ticket_ids) || typeof p.next.replace_existing !== "boolean") issues.push("next needs ticket_ids and replace_existing");
  else for (const id of p.next.ticket_ids) if (!ids.has(id)) issues.push(`next references unknown ticket ${id}`);
  issues.push(...validateTicketDefs(staged).map((issue) => `${issue.path}: ${issue.message}`));
  issues.push(...detectCycles(staged).map((cycle) => `dependency cycle: ${cycle}`));
  if (p.delivery) issues.push(...validateDeliveryConfig(p.delivery, staged).map((issue) => `delivery ${issue.path}: ${issue.message}`));
  return [...new Set([...contractIssues, ...issues])];
}

export interface ApplyTicketPlanOptions {
  expectedFingerprint: PlanningFingerprint[];
  docsRoot: string;
  now?: Date;
}

export interface AppliedTicketPlan {
  added: string[];
  edited: string[];
  artifacts: string[];
  backupDir: string;
}

export function applyApprovedTicketPlan(projectDir: string, proposal: TicketPlanProposal, opts: ApplyTicketPlanOptions): AppliedTicketPlan {
  const root = resolve(projectDir);
  const drift = planningFingerprintChanges(root, opts.expectedFingerprint);
  if (drift.length) throw new Error(`planning inputs changed after proposal generation: ${drift.join(", ")}; refresh the proposal and approve again`);
  const config = loadTicketsConfig(root);
  const paths = resolveTicketPaths(config, root);
  const existing = loadTickets(paths.tickets);
  if (existing.length > 0 && !existsSync(paths.stateDb)) throw new Error("tickets exist but the ignored ticket-state database is missing; restore it before planning so completed work is not treated as new");
  const currentContext = readTicketPlanningContext(root);
  const proposalIssues = validateTicketPlanProposal(proposal, existing, { futureWorkIds: currentContext.futureWork.flatMap((item) => typeof item.id === "number" ? [item.id] : []) });
  if (proposalIssues.length) throw new Error(`approved proposal is invalid:\n${proposalIssues.map((issue) => `- ${issue}`).join("\n")}`);

  const lockPath = join(root, ".tickets", "planning.lock");
  mkdirSync(dirname(lockPath), { recursive: true });
  let lock: number;
  try { lock = openSync(lockPath, "wx", 0o600); } catch { throw new Error(`another ticket planning apply holds ${lockPath}`); }
  const lockedDrift = planningFingerprintChanges(root, opts.expectedFingerprint);
  if (lockedDrift.length) {
    closeSync(lock);
    rmSync(lockPath, { force: true });
    throw new Error(`planning inputs changed while acquiring the apply lock: ${lockedDrift.join(", ")}; refresh the proposal and approve again`);
  }
  const docsRoot = validateDocsRoot(root, opts.docsRoot);
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const backupDir = join(root, ".tickets", "backups", `ticket-plan-${stamp}-${randomUUID().slice(0, 8)}`);
  const latestPlan = join(root, docsRoot, "rafi-ticket-plan.md");
  const historyPlan = join(root, docsRoot, "rafi-ticket-plans", `${stamp}.md`);
  const deliveryPath = join(root, ".tickets", "delivery.yaml");
  const configPath = join(root, "rafi-config.yaml");
  const material = [paths.tickets, paths.stateDb, `${paths.stateDb}-wal`, `${paths.stateDb}-shm`, deliveryPath, configPath, latestPlan, historyPlan, paths.progressDoc, paths.archiveDoc];
  mkdirSync(backupDir, { recursive: true });
  const backedUp: Array<{ original: string; backup: string }> = [];
  for (const original of material) if (existsSync(original)) {
    const backup = join(backupDir, `${backedUp.length}-${original.split(/[\\/]/).pop()}`);
    copyFileSync(original, backup); backedUp.push({ original, backup });
  }
  writeFileSync(join(backupDir, "journal.json"), `${JSON.stringify({ status: "prepared", createdAt: new Date().toISOString(), files: backedUp }, null, 2)}\n`, "utf8");

  try {
    const staged = stageTickets(existing, proposal);
    atomicWrite(paths.tickets, stringify({ tickets: staged }, { lineWidth: 120 }));
    if (proposal.delivery) atomicWrite(deliveryPath, stringify(normalizeDeliveryConfig(proposal.delivery), { lineWidth: 120 }));
    if (proposal.build_defaults) {
      const setup = mergeTicketSetup(loadTicketSetupConfig(root), { build: proposal.build_defaults });
      saveTicketSetupConfig(root, setup);
    }
    mkdirSync(dirname(latestPlan), { recursive: true });
    mkdirSync(dirname(historyPlan), { recursive: true });
    atomicWrite(latestPlan, `${proposal.markdown.trimEnd()}\n`);
    atomicWrite(historyPlan, `${proposal.markdown.trimEnd()}\n`);

    const db = new StateDb(paths.stateDb);
    try {
      const now = new Date().toISOString();
      db.transaction(() => {
        db.ensureSyntheticLegacyGroup(existing as Array<TicketDef & Record<string, unknown>>, opts.now ?? new Date());
        const existingNext = [...db.getAllStates().values()].filter((state) => state.status === "next").map((state) => state.ticket_id);
        if (proposal.next.replace_existing) for (const id of existingNext) db.upsertState(id, { status: "planned", updated_by: "rafi tickets plan" }, now);
        for (const link of proposal.supersessions) for (const id of link.replaced) {
          const current = db.getState(id);
          if (current?.status !== "done") db.upsertState(id, { status: "canceled", last_error: `Superseded: ${link.reason}`, updated_by: "rafi tickets plan" }, now);
          db.insertEvent({ timestamp: now, actor: "rafi tickets plan", ticket_id: id, event_type: "superseded", old_status: current?.status ?? "planned", new_status: current?.status === "done" ? "done" : "canceled", summary: link.reason, validation: null, evidence: current?.evidence ?? null, payload_json: JSON.stringify({ replacements: link.replacements }) });
        }
        for (const change of proposal.state_changes) {
          const current = db.getState(change.id);
          if (current?.status === "done" && change.status !== "done") throw new Error(`proposal cannot change completed ticket ${change.id} away from done`);
          db.upsertState(change.id, { status: change.status, updated_by: "rafi tickets plan" }, now);
        }
        for (const id of proposal.next.ticket_ids) db.upsertState(id, { status: "next", updated_by: "rafi tickets plan" }, now);
        for (const disposition of proposal.future_work) {
          if (!db.getFutureWorkById(disposition.id)) throw new Error(`future work item ${disposition.id} does not exist`);
          db.updateFutureWorkDisposition(disposition.id, disposition.disposition);
        }
        if (proposal.additions.length) {
          const operationDigest = createHash("sha256").update(JSON.stringify(proposal.additions)).digest("hex");
          db.createTicketGroup({ origin: "ticket-plan", operationId: `ticket-plan:${operationDigest}`, createdAt: now, members: proposal.additions.map((ticket) => ({ ticketId: ticket.id, definition: ticket, validatedAt: now })) });
        }
      });
      const states = db.getAllStates();
      renderAndWrite({ config, projectDir: root, ticketDefs: staged, states, db });
      const validation = runAllValidation(config, root, staged, states, db);
      const errors = validation.filter((issue) => issue.severity === "error");
      if (errors.length) throw new Error(`post-apply tracker validation failed:\n${errors.map((issue) => `- ${issue.message}`).join("\n")}`);
      for (const ticket of staged) if (db.getTicketGroupForTicket(ticket.id)) db.updateTicketDefinitionSnapshot(ticket.id, ticket, now);
    } finally { db.close(); }
    writeFileSync(join(backupDir, "journal.json"), `${JSON.stringify({ status: "committed", committedAt: new Date().toISOString(), files: backedUp }, null, 2)}\n`, "utf8");
    return { added: proposal.additions.map((ticket) => ticket.id), edited: proposal.edits.map((edit) => edit.id), artifacts: [relative(root, latestPlan), relative(root, historyPlan)], backupDir: relative(root, backupDir) };
  } catch (err) {
    for (const original of material) if (existsSync(original) && !backedUp.some((entry) => entry.original === original)) rmSync(original);
    for (const entry of backedUp) copyFileSync(entry.backup, entry.original);
    writeFileSync(join(backupDir, "journal.json"), `${JSON.stringify({ status: "rolled_back", rolledBackAt: new Date().toISOString(), error: err instanceof Error ? err.message : String(err), files: backedUp }, null, 2)}\n`, "utf8");
    throw err;
  } finally {
    closeSync(lock);
    rmSync(lockPath, { force: true });
  }
}

function stageTickets(existing: TicketDef[], proposal: TicketPlanProposal): TicketDef[] {
  const tickets = existing.map((ticket) => ({ ...ticket }));
  for (const edit of proposal.edits) {
    const index = tickets.findIndex((ticket) => ticket.id === edit.id);
    tickets[index] = { ...tickets[index]!, ...edit.patch, id: edit.id };
  }
  tickets.push(...proposal.additions.map((ticket) => ({ ...ticket })));
  for (const link of proposal.supersessions) {
    for (const id of link.replaced) {
      const ticket = tickets.find((candidate) => candidate.id === id)!;
      ticket.superseded_by = [...new Set([...(ticket.superseded_by ?? []), ...link.replacements])];
    }
    for (const id of link.replacements) {
      const ticket = tickets.find((candidate) => candidate.id === id)!;
      ticket.supersedes = [...new Set([...(ticket.supersedes ?? []), ...link.replaced])];
    }
  }
  return tickets.sort((a, b) => a.order - b.order);
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

function fileHash(path: string): string | null {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
