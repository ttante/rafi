import type { TicketDef } from "../tickets/ticketSchema.js";
import type { TicketState } from "../tickets/stateDb.js";
import type { BranchIssue, BranchPlan, BranchPlanNode } from "./types.js";

export interface AuditDependency {
  ticket: string;
  dependsOn: string;
  reason?: string;
}

export interface BuildBranchPlanOptions {
  steps: number;
  baseRef: string;
  branchPrefix: string;
  maxBranchDepth: number;
  auditDependencies?: AuditDependency[];
  rootBaseBranches?: boolean;
  ticketIds?: string[];
}

export function buildBranchPlan(
  tickets: TicketDef[],
  states: Map<string, TicketState>,
  opts: BuildBranchPlanOptions,
): BranchPlan {
  const selected = selectTicketsForBranchRun(tickets, states, opts.steps, opts.ticketIds);
  const selectedIds = new Set(selected.map((ticket) => ticket.id));
  const issues: BranchIssue[] = [];
  const dependencyMap = new Map<string, string[]>();

  for (const ticket of selected) {
    dependencyMap.set(ticket.id, ticket.depends_on.filter((dep) => selectedIds.has(dep)));
  }

  for (const dep of opts.auditDependencies ?? []) {
    if (!selectedIds.has(dep.ticket) || !selectedIds.has(dep.dependsOn)) continue;
    const existing = dependencyMap.get(dep.ticket) ?? [];
    if (!existing.includes(dep.dependsOn)) existing.push(dep.dependsOn);
    dependencyMap.set(dep.ticket, existing);
  }

  for (const cycle of detectSelectedCycles(selected, dependencyMap)) {
    issues.push({ code: "cycle", message: `branch dependency cycle: ${cycle}`, blocking: true });
  }

  const usedBranches = new Set<string>();
  const branchById = new Map<string, string>();
  const nodeById = new Map<string, BranchPlanNode>();
  const depthMemo = new Map<string, number>();

  const depthOf = (id: string, visiting = new Set<string>()): number => {
    if (depthMemo.has(id)) return depthMemo.get(id)!;
    if (visiting.has(id)) return Number.POSITIVE_INFINITY;
    visiting.add(id);
    const deps = dependencyMap.get(id) ?? [];
    const depth = deps.length === 0 ? 1 : Math.max(...deps.map((dep) => depthOf(dep, visiting))) + 1;
    visiting.delete(id);
    depthMemo.set(id, depth);
    return depth;
  };

  for (const ticket of selected) {
    const dependencies = dependencyMap.get(ticket.id) ?? [];
    if (dependencies.length > 1 && !hasAncestorJoin(dependencies, dependencyMap)) {
      issues.push({
        ticket: ticket.id,
        code: "multi_root_join",
        message: `${ticket.id} depends on multiple selected roots (${dependencies.join(", ")})`,
        blocking: true,
      });
    }
    const depth = depthOf(ticket.id);
    if (depth > opts.maxBranchDepth) {
      issues.push({
        ticket: ticket.id,
        code: "depth_exceeded",
        message: `${ticket.id} branch depth ${depth} exceeds --max-branch-depth ${opts.maxBranchDepth}`,
        blocking: true,
      });
    }
  }

  for (const ticket of selected) {
    branchById.set(ticket.id, uniqueBranchName(opts.branchPrefix, ticket, usedBranches));
  }

  for (const ticket of selected) {
    const dependencies = dependencyMap.get(ticket.id) ?? [];
    const branch = branchById.get(ticket.id)!;
    const baseTicket = chooseBaseDependency(dependencies, dependencyMap);
    const baseBranch = opts.rootBaseBranches
      ? opts.baseRef
      : baseTicket ? (branchById.get(baseTicket) ?? opts.baseRef) : opts.baseRef;
    const node: BranchPlanNode = {
      ticket,
      branch,
      baseRef: opts.baseRef,
      baseBranch,
      dependencies,
      depth: depthOf(ticket.id),
    };
    nodeById.set(ticket.id, node);
  }

  return { baseRef: opts.baseRef, nodes: selected.map((ticket) => nodeById.get(ticket.id)!), issues };
}

export function selectTicketsForBranchRun(
  tickets: TicketDef[],
  states: Map<string, TicketState>,
  steps: number,
  ticketIds?: string[],
): TicketDef[] {
  const allowed = ticketIds ? new Set(ticketIds) : undefined;
  const remaining = tickets
    .filter((ticket) => {
      if (allowed && !allowed.has(ticket.id)) return false;
      const status = states.get(ticket.id)?.status ?? "planned";
      return status !== "done" && status !== "canceled" && status !== "obsolete";
    })
    .sort((a, b) => a.order - b.order);

  const simulatedDone = new Set(
    Array.from(states.values())
      .filter((state) => state.status === "done")
      .map((state) => state.ticket_id),
  );
  const selected: TicketDef[] = [];

  for (const ticket of remaining) {
    if (selected.length >= steps) break;
    if (ticket.depends_on.every((dep) => simulatedDone.has(dep))) {
      selected.push(ticket);
      simulatedDone.add(ticket.id);
    }
  }

  return selected;
}

export function applySharedDeliveryBranch(
  plan: BranchPlan,
  unitId: string,
  allRemainingTicketIds: string[],
  branchPrefix = "rafi",
): BranchPlan {
  if (plan.nodes.length === 0) return plan;
  const slug = unitId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "group";
  const branch = `${branchPrefix.replace(/^\/+|\/+$/g, "") || "rafi"}/${slug}`;
  const finalSelected = plan.nodes.at(-1)?.ticket.id;
  const completesUnit = plan.nodes.length === allRemainingTicketIds.length
    && allRemainingTicketIds.every((id) => plan.nodes.some((node) => node.ticket.id === id));
  return {
    ...plan,
    nodes: plan.nodes.map((node) => ({
      ...node,
      branch,
      baseBranch: plan.baseRef,
      deliveryUnitId: unitId,
      deliveryUnitFinal: completesUnit && node.ticket.id === finalSelected,
    })),
  };
}

export function parseAuditDependencies(text: string): AuditDependency[] {
  const deps: AuditDependency[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/\b([A-Za-z][A-Za-z0-9-_]*)\s+(?:depends_on|depends on|after)\s+([A-Za-z][A-Za-z0-9-_]*)\b/i);
    if (match) deps.push({ ticket: match[1], dependsOn: match[2], reason: line.trim() });
  }
  return deps;
}

export function buildBranchAuditInstruction(tickets: TicketDef[]): string {
  const body = tickets.map((ticket) => [
    `${ticket.id}: ${ticket.title}`,
    `Summary: ${ticket.summary}`,
    `Acceptance: ${ticket.acceptance.join("; ")}`,
    `Likely files: ${ticket.likely_files.join(", ") || "unknown"}`,
    `Declared depends_on: ${ticket.depends_on.join(", ") || "None"}`,
  ].join("\n")).join("\n\n");

  return `Audit this selected ticket batch for undeclared code dependencies. Do not implement anything.

Return one line per required selected-ticket dependency using:
<ticket> depends_on <ticket> - <short reason>

Only name dependencies where both tickets are in this selected batch. If there are none, say "None".

${body}`;
}

function uniqueBranchName(prefix: string, ticket: TicketDef, used: Set<string>): string {
  const cleanPrefix = prefix.replace(/^\/+|\/+$/g, "") || "rafi";
  const baseSlug = `${ticket.id}-${ticket.title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  let branch = `${cleanPrefix}/${baseSlug}`;
  let i = 2;
  while (used.has(branch)) {
    branch = `${cleanPrefix}/${baseSlug}-${i}`;
    i++;
  }
  used.add(branch);
  return branch;
}

function detectSelectedCycles(tickets: TicketDef[], deps: Map<string, string[]>): string[] {
  const selected = new Set(tickets.map((ticket) => ticket.id));
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const cycles: string[] = [];

  function dfs(id: string, path: string[]): void {
    if (inStack.has(id)) {
      const start = path.indexOf(id);
      cycles.push([...path.slice(start), id].join(" -> "));
      return;
    }
    if (visited.has(id)) return;
    visited.add(id);
    inStack.add(id);
    for (const dep of deps.get(id) ?? []) {
      if (selected.has(dep)) dfs(dep, [...path, id]);
    }
    inStack.delete(id);
  }

  for (const ticket of tickets) dfs(ticket.id, []);
  return cycles;
}

function hasAncestorJoin(parents: string[], deps: Map<string, string[]>): boolean {
  for (const left of parents) {
    for (const right of parents) {
      if (left !== right && isAncestor(left, right, deps)) return true;
    }
  }
  return false;
}

function isAncestor(
  ancestor: string,
  child: string,
  deps: Map<string, string[]>,
  visited = new Set<string>(),
): boolean {
  if (visited.has(child)) return false;
  visited.add(child);
  for (const dep of deps.get(child) ?? []) {
    if (dep === ancestor || isAncestor(ancestor, dep, deps, visited)) return true;
  }
  return false;
}

function chooseBaseDependency(dependencies: string[], deps: Map<string, string[]>): string | undefined {
  if (dependencies.length === 0) return undefined;
  return [...dependencies].sort((a, b) => chainDepth(b, deps) - chainDepth(a, deps))[0];
}

function chainDepth(id: string, deps: Map<string, string[]>, visiting = new Set<string>()): number {
  if (visiting.has(id)) return 0;
  visiting.add(id);
  const parents = deps.get(id) ?? [];
  const depth = parents.length === 0 ? 1 : Math.max(...parents.map((dep) => chainDepth(dep, deps, visiting))) + 1;
  visiting.delete(id);
  return depth;
}
