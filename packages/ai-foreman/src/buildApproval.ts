import { loadDeliveryConfig, normalizeDeliveryConfig } from "./tickets/delivery.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { WorkflowDb } from "./workflowDb.js";
import { loadTicketsConfig, resolveTicketPaths } from "./tickets/config.js";
import { loadTickets } from "./tickets/ticketLoader.js";
import { StateDb } from "./tickets/stateDb.js";
import type { TicketDef } from "./tickets/ticketSchema.js";

function canonical(value: unknown): string {
  const normalize = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(normalize) : entry && typeof entry === "object"
    ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, normalize(val)])) : entry;
  return JSON.stringify(normalize(value));
}
function material(ticket: TicketDef): unknown {
  return { id: ticket.id, plan_ref: ticket.plan_ref, title: ticket.title, summary: ticket.summary, acceptance: ticket.acceptance,
    required_tests: ticket.required_tests, depends_on: ticket.depends_on, likely_files: ticket.likely_files, rollback: ticket.rollback, source_refs: ticket.source_refs };
}

/** Reuse only source-bound approval. Ambiguous legacy provenance still asks. */
export function approvedBuildScope(projectDir: string, ticketIds?: readonly string[]): { approved: boolean; reason: string; digest?: string } {
  try {
    const paths = resolveTicketPaths(loadTicketsConfig(projectDir), projectDir);
    const all = loadTickets(paths.tickets);
    const state = new StateDb(paths.stateDb);
    let tickets: TicketDef[];
    try { tickets = ticketIds ? all.filter(ticket => ticketIds.includes(ticket.id)) : all.filter(ticket => !["done", "obsolete", "cancelled", "canceled"].includes(state.getState(ticket.id)?.status ?? "planned")); }
    finally { state.close(); }
    if (!tickets.length || (ticketIds && tickets.length !== new Set(ticketIds).size) || tickets.some(ticket => !ticket.plan_ref)) return { approved: false, reason: "selected tickets lack approved plan provenance" };
    const db = new WorkflowDb(projectDir);
    try {
      const approvals = db.completedPlanApprovals();
      const definitions = db.approvedPopulationDefinitions() as TicketDef[];
      for (const ticket of tickets) {
        const ref = ticket.plan_ref!;
        const receipt = approvals.find(item => item.planId === ref.plan_id && item.revision === ref.revision);
        if (!receipt) return { approved: false, reason: `no stored approval for ${ticket.id}` };
        const config = parse(readFileSync(join(projectDir, "rafi-config.yaml"), "utf8")) as { docs?: { root?: string }; tickets?: { build?: { branch_strategy?: string; branch_prefix?: string } } };
        const plan = JSON.parse(readFileSync(join(projectDir, config.docs?.root ?? "docs", "rafi-plan.json"), "utf8"));
        const digest = createHash("sha256").update(canonical({ ...plan, content_digest: "" })).digest("hex");
        if (plan.plan_id !== ref.plan_id || plan.revision !== ref.revision || digest !== plan.content_digest || digest !== receipt.digest) return { approved: false, reason: "approved plan revision or digest changed" };
        const approved = definitions.find(item => item.id === ticket.id && canonical(item.plan_ref) === canonical(ref));
        // Older populations have no immutable definition receipt. Only an exact
        // match to the digested approved slice is safe to reuse automatically.
        const slice = plan.slices?.find((item: { slice_ref: string }) => item.slice_ref === ref.slice_ref);
        const ids = new Map(all.filter(item => item.plan_ref?.plan_id === ref.plan_id && item.plan_ref.revision === ref.revision).map(item => [item.plan_ref!.slice_ref, item.id]));
        const legacy = slice && !ticket.rollback ? { ...ticket, title: slice.title, summary: slice.summary,
          acceptance: slice.acceptance, required_tests: slice.required_tests, likely_files: slice.likely_files,
          depends_on: (slice.depends_on ?? []).map((id: string) => ids.get(id)),
          source_refs: slice.source_refs?.map((source: Record<string, unknown>) => ({ source: source.source_id, item: source.item ?? "document", source_id: source.source_id, fingerprint: source.fingerprint, ...(source.url !== undefined ? { url: source.url } : {}), ...(source.note !== undefined ? { note: source.note } : {}) })) } : undefined;
        if (canonical(material(approved ?? legacy ?? {} as TicketDef)) !== canonical(material(ticket))) return { approved: false, reason: `material ticket changes or missing immutable approval for ${ticket.id}` };
        const actualDelivery = loadDeliveryConfig(projectDir);
        if (actualDelivery?.units.length && !Array.isArray(plan.delivery_units)) return { approved: false, reason: "delivery configuration has no approved provenance" };
        if (Array.isArray(plan.delivery_units) && (plan.delivery_units.length || actualDelivery?.units.length)) {
          const ids = new Map(all.filter(item => item.plan_ref?.plan_id === ref.plan_id).map(item => [item.plan_ref!.slice_ref, item.id]));
          const expected = normalizeDeliveryConfig({ version: 1, plan: { plan_id: plan.plan_id, revision: plan.revision },
            units: plan.delivery_units.map((unit: Record<string, unknown>) => ({ ...unit, tickets: (unit.slice_refs as string[]).map(slice => ids.get(slice)) })),
            stacks: (plan.stacks ?? []).map((stack: { stack_id: string; name: string; units: string[] }) => ({ id: stack.stack_id, name: stack.name, units: stack.units, status: "planned" })) });
          const actual = loadDeliveryConfig(projectDir);
          if (!actual || canonical(actual.units) !== canonical(expected.units)) return { approved: false, reason: "approved delivery consequences changed" };
        }
        const decisions = receipt.decisionReceipt as { workMode?: string; branchPrefix?: string; planDigest?: string } | undefined;
        if (!decisions || decisions.planDigest !== digest || decisions.workMode !== config.tickets?.build?.branch_strategy || decisions.branchPrefix !== config.tickets?.build?.branch_prefix) return { approved: false, reason: "approved workflow consequences changed" };
      }
      return { approved: true, reason: "unchanged approved plan and ticket definitions", digest: createHash("sha256").update(canonical(tickets.map(material))).digest("hex") };
    } finally { db.close(); }
  } catch { return { approved: false, reason: "approval evidence unavailable" }; }
}

export function requiresBuildApproval(projectDir: string, ticketIds: readonly string[] | undefined, explicitYes: boolean, consequences?: Record<string, unknown>): boolean {
  const scope = approvedBuildScope(projectDir, ticketIds);
  let changedConsequences = false;
  if (consequences) {
    try {
      const saved = parse(readFileSync(join(projectDir, "rafi-config.yaml"), "utf8"))?.tickets?.build ?? {};
      changedConsequences = Object.entries(consequences).some(([key, value]) => value !== undefined && canonical(value) !== canonical(saved[key] ?? ({ completion: "none", branch_strategy: "current", branch_prefix: "feature", merge_method: "squash", pr_ready: false } as Record<string, unknown>)[key]));
    } catch { changedConsequences = true; }
  }
  if (scope.approved && !changedConsequences) return false;
  if (!explicitYes) return true;
  const db = new WorkflowDb(projectDir);
  try { return db.completedPlanApprovals().length > 0; }
  finally { db.close(); }
}

/** Bind decisions to current files so an old answer cannot approve a changed scope. */
export function buildScopeRevision(projectDir: string, consequences?: Record<string, unknown>): string {
  const paths = resolveTicketPaths(loadTicketsConfig(projectDir), projectDir);
  let docsRoot = "docs";
  try { docsRoot = parse(readFileSync(join(projectDir, "rafi-config.yaml"), "utf8"))?.docs?.root ?? docsRoot; } catch { /* unavailable config changes the fingerprint below */ }
  const contents = [join(projectDir, docsRoot, "rafi-plan.json"), paths.tickets, join(projectDir, "rafi-config.yaml"), join(projectDir, ".tickets/delivery.yaml")].map(path => {
    try { return readFileSync(path, "utf8"); } catch { return "unavailable"; }
  });
  return createHash("sha256").update(JSON.stringify([contents, consequences])).digest("hex");
}
