import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { randomUUID } from "node:crypto";
import type { TicketDef } from "./ticketSchema.js";
import type { TicketState } from "./stateDb.js";
import type {
  TicketBuildCompletionMode,
  TicketBuildMergeMethod,
  TicketBuildProvider,
} from "./setupConfig.js";

export const DELIVERY_FILE = ".tickets/delivery.yaml";
export type DeliveryBranchMode = "current" | "per-ticket" | "shared";
export type DeliveryDependencyMode = "combine" | "wait" | "stack";

export interface DeliveryUnit {
  id: string;
  tickets: string[];
  branch_mode: DeliveryBranchMode;
  completion?: TicketBuildCompletionMode;
  provider?: TicketBuildProvider;
  pr_ready?: boolean;
  merge_method?: TicketBuildMergeMethod;
  cleanup?: boolean;
  depends_on?: string[];
  dependency_mode?: DeliveryDependencyMode;
}

export type StackDeliveryState = "planned" | "in_progress" | "partial" | "blocked" | "awaiting_review" | "merged";
export interface DeliveryStack {
  id: string;
  name: string;
  /** Straight root-to-tip chain of delivery unit IDs. */
  units: string[];
  status?: StackDeliveryState;
  completed_prefix?: string[];
  next_ticket?: string;
  review_links?: string[];
  remote_checked_at?: string;
  remote_stale?: boolean;
  /** Stable PR-node branch identities retained for partial-stack recovery. */
  published_branches?: Record<string, string>;
}

export interface DeliveryConfig {
  version: 1;
  plan?: { plan_id: string; revision: number };
  units: DeliveryUnit[];
  stacks?: DeliveryStack[];
}

export interface DeliveryIssue {
  path: string;
  message: string;
}

export function loadDeliveryConfig(projectDir: string): DeliveryConfig | undefined {
  const path = join(projectDir, DELIVERY_FILE);
  if (!existsSync(path)) return undefined;
  const raw = parse(readFileSync(path, "utf8")) as unknown;
  const issues = validateDeliveryConfig(raw);
  if (issues.length > 0) {
    throw new Error(`${DELIVERY_FILE}:\n${issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n")}`);
  }
  return normalizeDeliveryConfig(raw);
}

export function saveDeliveryConfig(projectDir: string, config: DeliveryConfig): void {
  const issues = validateDeliveryConfig(config);
  if (issues.length) throw new Error(`${DELIVERY_FILE}: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
  const target = join(projectDir, DELIVERY_FILE); const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, stringify(config, { lineWidth: 120 }), "utf8"); renameSync(temp, target);
}

export function normalizeDeliveryConfig(raw: unknown): DeliveryConfig {
  const value = raw as Record<string, unknown>;
  return {
    version: 1,
    ...(value.plan && typeof value.plan === "object" ? { plan: { plan_id: String((value.plan as Record<string, unknown>).plan_id), revision: Number((value.plan as Record<string, unknown>).revision) } } : {}),
    units: (value.units as Array<Record<string, unknown>>).map((unit) => ({
      id: String(unit.id),
      tickets: [...(unit.tickets as string[])],
      branch_mode: unit.branch_mode as DeliveryBranchMode,
      ...(unit.completion ? { completion: unit.completion as TicketBuildCompletionMode } : {}),
      ...(unit.provider ? { provider: unit.provider as TicketBuildProvider } : {}),
      ...(typeof unit.pr_ready === "boolean" ? { pr_ready: unit.pr_ready } : {}),
      ...(unit.merge_method ? { merge_method: unit.merge_method as TicketBuildMergeMethod } : {}),
      ...(typeof unit.cleanup === "boolean" ? { cleanup: unit.cleanup } : {}),
      ...(Array.isArray(unit.depends_on) ? { depends_on: [...unit.depends_on] as string[] } : {}),
      ...(unit.dependency_mode ? { dependency_mode: unit.dependency_mode as DeliveryDependencyMode } : {}),
    })),
    ...(Array.isArray(value.stacks) ? { stacks: (value.stacks as Array<Record<string, unknown>>).map((stack) => ({
      id: String(stack.id), name: String(stack.name), units: [...(stack.units as string[])],
      ...(stack.status ? { status: stack.status as StackDeliveryState } : {}),
      ...(Array.isArray(stack.completed_prefix) ? { completed_prefix: [...stack.completed_prefix] as string[] } : {}),
      ...(stack.next_ticket ? { next_ticket: String(stack.next_ticket) } : {}),
      ...(Array.isArray(stack.review_links) ? { review_links: [...stack.review_links] as string[] } : {}),
      ...(stack.remote_checked_at ? { remote_checked_at: String(stack.remote_checked_at) } : {}),
      ...(typeof stack.remote_stale === "boolean" ? { remote_stale: stack.remote_stale } : {}),
      ...(stack.published_branches && typeof stack.published_branches === "object" ? { published_branches: { ...(stack.published_branches as Record<string, string>) } } : {}),
    })) } : {}),
  };
}

export function validateDeliveryConfig(raw: unknown, ticketDefs?: TicketDef[]): DeliveryIssue[] {
  const issues: DeliveryIssue[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [{ path: "$", message: "expected an object" }];
  const value = raw as Record<string, unknown>;
  if (value.version !== undefined && value.version !== 1) issues.push({ path: "version", message: "expected 1" });
  if (value.plan !== undefined) {
    const plan = value.plan as Record<string, unknown> | undefined;
    if (!plan || typeof plan !== "object" || typeof plan.plan_id !== "string" || !Number.isInteger(plan.revision) || Number(plan.revision) < 1) issues.push({ path: "plan", message: "expected plan_id and positive integer revision" });
  }
  if (!Array.isArray(value.units)) return [...issues, { path: "units", message: "expected an array" }];
  const unitIds = new Set<string>();
  const assigned = new Map<string, string>();
  const knownTickets = ticketDefs ? new Set(ticketDefs.map((ticket) => ticket.id)) : undefined;

  for (let index = 0; index < value.units.length; index++) {
    const path = `units[${index}]`;
    const unit = value.units[index];
    if (!unit || typeof unit !== "object" || Array.isArray(unit)) {
      issues.push({ path, message: "expected an object" });
      continue;
    }
    const u = unit as Record<string, unknown>;
    if (typeof u.id !== "string" || !/^[A-Za-z][A-Za-z0-9-_]*$/.test(u.id)) issues.push({ path: `${path}.id`, message: "expected a stable identifier" });
    else if (unitIds.has(u.id)) issues.push({ path: `${path}.id`, message: `duplicate unit ID: ${u.id}` });
    else unitIds.add(u.id);
    if (!Array.isArray(u.tickets) || u.tickets.length === 0 || !u.tickets.every((id) => typeof id === "string" && id.length > 0)) {
      issues.push({ path: `${path}.tickets`, message: "expected a non-empty ticket ID array" });
    } else {
      for (const id of u.tickets as string[]) {
        if (knownTickets && !knownTickets.has(id)) issues.push({ path: `${path}.tickets`, message: `unknown ticket: ${id}` });
        const prior = assigned.get(id);
        if (prior) issues.push({ path: `${path}.tickets`, message: `${id} is already assigned to ${prior}` });
        else assigned.set(id, typeof u.id === "string" ? u.id : path);
      }
    }
    enumValue(issues, `${path}.branch_mode`, u.branch_mode, ["current", "per-ticket", "shared"], true);
    enumValue(issues, `${path}.completion`, u.completion, ["pr", "auto-merge", "direct-merge", "none"]);
    enumValue(issues, `${path}.provider`, u.provider, ["auto", "github", "gitlab", "local"]);
    enumValue(issues, `${path}.merge_method`, u.merge_method, ["squash", "merge", "rebase"]);
    enumValue(issues, `${path}.dependency_mode`, u.dependency_mode, ["combine", "wait", "stack"]);
    for (const field of ["pr_ready", "cleanup"] as const) {
      if (u[field] !== undefined && typeof u[field] !== "boolean") issues.push({ path: `${path}.${field}`, message: "expected a boolean" });
    }
    if (u.depends_on !== undefined && (!Array.isArray(u.depends_on) || !u.depends_on.every((id) => typeof id === "string"))) {
      issues.push({ path: `${path}.depends_on`, message: "expected a unit ID array" });
    }
  }

  const units = value.units.filter((unit): unit is Record<string, unknown> => Boolean(unit && typeof unit === "object" && !Array.isArray(unit)));
  for (const unit of units) {
    for (const dep of Array.isArray(unit.depends_on) ? unit.depends_on : []) {
      if (!unitIds.has(String(dep))) issues.push({ path: `units[${String(unit.id)}].depends_on`, message: `unknown unit: ${String(dep)}` });
      if (dep === unit.id) issues.push({ path: `units[${String(unit.id)}].depends_on`, message: "unit cannot depend on itself" });
    }
  }
  for (const cycle of deliveryCycles(units)) issues.push({ path: "units", message: `dependency cycle: ${cycle}` });
  issues.push(...validateDeliveryStacks(value.stacks, units, ticketDefs, value.plan as { plan_id: string; revision: number } | undefined));
  return issues;
}

export interface NormalizedStackNode { stackId: string; unitId: string; ticketId: string; depth: number }

export function normalizeStackNodes(stack: DeliveryStack, units: DeliveryUnit[], ticketDefs: TicketDef[] = []): NormalizedStackNode[] {
  const order = new Map(ticketDefs.map((ticket) => [ticket.id, ticket.order]));
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const nodes: NormalizedStackNode[] = [];
  for (const unitId of stack.units) {
    const unit = byId.get(unitId); if (!unit) continue;
    const tickets = [...unit.tickets].sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER));
    if (unit.branch_mode === "shared") nodes.push({ stackId: stack.id, unitId, ticketId: tickets.join("+"), depth: nodes.length + 1 });
    else for (const ticketId of tickets) nodes.push({ stackId: stack.id, unitId, ticketId, depth: nodes.length + 1 });
  }
  return nodes;
}

function validateDeliveryStacks(raw: unknown, units: Record<string, unknown>[], ticketDefs?: TicketDef[], plan?: { plan_id: string; revision: number }): DeliveryIssue[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return [{ path: "stacks", message: "expected an array" }];
  const issues: DeliveryIssue[] = []; const byId = new Map(units.map((unit) => [String(unit.id), unit]));
  const stackIds = new Set<string>(); const assigned = new Set<string>();
  const ticketById = new Map((ticketDefs ?? []).map((ticket) => [ticket.id, ticket]));
  const queueIndex = new Map((ticketDefs ?? []).slice().sort((a, b) => a.order - b.order).map((ticket, index) => [ticket.id, index]));
  const stackedTicketIds = new Set<string>();
  for (let index = 0; index < raw.length; index++) {
    const stack = raw[index] as Record<string, unknown>; const path = `stacks[${index}]`;
    if (!stack || typeof stack !== "object" || typeof stack.id !== "string" || !stack.id) { issues.push({ path: `${path}.id`, message: "expected stable stack ID" }); continue; }
    if (stackIds.has(stack.id)) issues.push({ path: `${path}.id`, message: `duplicate stack ID ${stack.id}` }); else stackIds.add(stack.id);
    if (typeof stack.name !== "string" || !stack.name.trim()) issues.push({ path: `${path}.name`, message: "expected a name" });
    if (!Array.isArray(stack.units) || stack.units.length === 0 || !stack.units.every((id) => typeof id === "string")) { issues.push({ path: `${path}.units`, message: "expected ordered unit IDs" }); continue; }
    for (const unitId of stack.units as string[]) {
      const unit = byId.get(unitId);
      if (!unit) { issues.push({ path: `${path}.units`, message: `unknown unit ${unitId}` }); continue; }
      if (assigned.has(unitId)) issues.push({ path: `${path}.units`, message: `unit ${unitId} belongs to more than one stack` }); else assigned.add(unitId);
      if (unit.branch_mode === "current") issues.push({ path: `${path}.units`, message: `current-branch unit ${unitId} cannot be stacked` });
      if (unit.completion !== "pr") issues.push({ path: `${path}.units`, message: `stacked unit ${unitId} must use completion: pr` });
      if (!["github", "gitlab"].includes(String(unit.provider))) issues.push({ path: `${path}.units`, message: `stacked unit ${unitId} must use github or gitlab` });
      if (unit.dependency_mode !== "stack") issues.push({ path: `${path}.units`, message: `stacked unit ${unitId} must use dependency_mode: stack` });
      for (const ticketId of Array.isArray(unit.tickets) ? unit.tickets as string[] : []) stackedTicketIds.add(ticketId);
    }
    const providers = new Set((stack.units as string[]).map((id) => String(byId.get(id)?.provider ?? "")));
    if (providers.size > 1) issues.push({ path: `${path}.units`, message: "all nodes in a stack must use the same provider" });
    const typed = { id: stack.id, name: String(stack.name), units: stack.units as string[] };
    const nodes = normalizeStackNodes(typed, units as unknown as DeliveryUnit[], ticketDefs);
    if (nodes.length > 5) issues.push({ path: `${path}.units`, message: `normalized PR depth ${nodes.length} exceeds maximum 5` });
    const rootDeps = Array.isArray(byId.get(typed.units[0]!)?.depends_on) ? byId.get(typed.units[0]!)!.depends_on as string[] : [];
    if (rootDeps.length) issues.push({ path: `${path}.units`, message: `root unit ${typed.units[0]} cannot have a stack parent` });
    for (let unitIndex = 1; unitIndex < typed.units.length; unitIndex++) {
      const id = typed.units[unitIndex]!; const predecessor = typed.units[unitIndex - 1]!;
      const deps = Array.isArray(byId.get(id)?.depends_on) ? byId.get(id)!.depends_on as string[] : [];
      if (deps.length !== 1 || deps[0] !== predecessor) issues.push({ path: `${path}.units`, message: `unit ${id} must depend only on immediate predecessor ${predecessor}` });
    }
    for (const unitId of typed.units) {
      const unit = byId.get(unitId); if (unit?.branch_mode !== "per-ticket") continue;
      const tickets = (unit.tickets as string[]).slice().sort((a, b) => (queueIndex.get(a) ?? 0) - (queueIndex.get(b) ?? 0));
      for (let ticketIndex = 1; ticketIndex < tickets.length; ticketIndex++) {
        const deps = ticketById.get(tickets[ticketIndex]!)?.depends_on ?? [];
        if (!deps.includes(tickets[ticketIndex - 1]!)) issues.push({ path: `${path}.units`, message: `per-ticket node ${tickets[ticketIndex]} must depend on predecessor ${tickets[ticketIndex - 1]}` });
      }
    }
    const indices = typed.units.flatMap((unitId) => Array.isArray(byId.get(unitId)?.tickets) ? byId.get(unitId)!.tickets as string[] : [])
      .map((ticketId) => queueIndex.get(ticketId)).filter((value): value is number => value !== undefined).sort((a, b) => a - b);
    if (indices.some((value, position) => position > 0 && value !== indices[position - 1]! + 1)) issues.push({ path: `${path}.units`, message: "stack tickets must be contiguous in queue order" });
  }
  if (plan && ticketDefs) for (const ticket of ticketDefs) if (stackedTicketIds.has(ticket.id) && ticket.plan_ref && ticket.plan_ref.plan_id !== plan.plan_id) issues.push({ path: "plan", message: `stack ticket ${ticket.id} belongs to plan ${ticket.plan_ref.plan_id}, not ${plan.plan_id}` });
  return issues;
}

function enumValue(issues: DeliveryIssue[], path: string, value: unknown, allowed: string[], required = false): void {
  if (value === undefined && !required) return;
  if (typeof value !== "string" || !allowed.includes(value)) issues.push({ path, message: `expected one of: ${allowed.join(", ")}` });
}

function deliveryCycles(units: Record<string, unknown>[]): string[] {
  const deps = new Map(units.map((unit) => [String(unit.id), (Array.isArray(unit.depends_on) ? unit.depends_on : []).map(String)]));
  const visited = new Set<string>();
  const stack = new Set<string>();
  const cycles: string[] = [];
  const walk = (id: string, path: string[]): void => {
    if (stack.has(id)) { cycles.push([...path.slice(path.indexOf(id)), id].join(" -> ")); return; }
    if (visited.has(id)) return;
    visited.add(id); stack.add(id);
    for (const dep of deps.get(id) ?? []) if (deps.has(dep)) walk(dep, [...path, id]);
    stack.delete(id);
  };
  for (const id of deps.keys()) walk(id, []);
  return cycles;
}

export interface DeliveryUnitProgress {
  unit: DeliveryUnit;
  completed: number;
  remaining: string[];
  state: "complete" | "ready" | "waiting" | "resume";
}

export function deliveryProgress(config: DeliveryConfig, states: Map<string, TicketState>): DeliveryUnitProgress[] {
  const completedUnits = new Set(config.units.filter((unit) => unit.tickets.every((id) => ["done", "canceled", "obsolete"].includes(states.get(id)?.status ?? "planned"))).map((unit) => unit.id));
  const out: DeliveryUnitProgress[] = [];
  for (const unit of config.units) {
    const remaining = unit.tickets.filter((id) => !["done", "canceled", "obsolete"].includes(states.get(id)?.status ?? "planned"));
    const started = unit.tickets.some((id) => ["in_progress", "blocked", "done"].includes(states.get(id)?.status ?? "planned"));
    const waiting = (unit.depends_on ?? []).some((id) => !completedUnits.has(id));
    out.push({
      unit,
      completed: unit.tickets.length - remaining.length,
      remaining,
      state: remaining.length === 0 ? "complete" : waiting ? "waiting" : started ? "resume" : "ready",
    });
  }
  return out;
}

export function formatDeliverySummary(config: DeliveryConfig, states: Map<string, TicketState>): string[] {
  return deliveryProgress(config, states).map(({ unit, completed, remaining, state }) =>
    `${unit.id}: ${completed}/${unit.tickets.length} complete; ${remaining.length} remaining; ${unit.branch_mode}; ${unit.completion ?? "repository default"}; ${state}${(unit.depends_on ?? []).length ? `; depends on ${(unit.depends_on ?? []).join(", ")}` : ""}`,
  );
}

export function selectDeliveryUnitForRun(
  config: DeliveryConfig,
  states: Map<string, TicketState>,
  skipUnitIds: readonly string[] = [],
): DeliveryUnitProgress | undefined {
  const skipped = new Set(skipUnitIds);
  const progress = deliveryProgress(config, states).filter((item) => !skipped.has(item.unit.id));
  return progress.find((item) => item.state === "resume") ?? progress.find((item) => item.state === "ready");
}

export interface StackBatchSelection { stacks: DeliveryStack[]; tickets: string[]; error?: string }

/** Complete preflight simulation for exact `--stacks N` selection. */
export function selectStacksForRun(config: DeliveryConfig, ticketDefs: TicketDef[], states: Map<string, TicketState>, count: number): StackBatchSelection {
  if (!Number.isInteger(count) || count < 1) return { stacks: [], tickets: [], error: "--stacks must be a positive integer" };
  const stacks = config.stacks ?? []; const unitById = new Map(config.units.map((unit) => [unit.id, unit]));
  const defs = new Map(ticketDefs.map((ticket) => [ticket.id, ticket]));
  const candidates = [...stacks].sort((a, b) => {
    const ap = stackStarted(a, unitById, states) ? 0 : 1; const bp = stackStarted(b, unitById, states) ? 0 : 1;
    return ap - bp;
  });
  const firstPartial = candidates.find((stack) => stackStarted(stack, unitById, states) && !stackComplete(stack, unitById, states));
  if (firstPartial) {
    const blocker = externalStackBlocker(firstPartial, unitById, defs, states);
    if (blocker) return { stacks: [], tickets: [], error: `partial stack ${firstPartial.name} (${firstPartial.id}) is blocked by ${blocker}; finish or unblock it before starting a newer stack` };
  }
  const selected: DeliveryStack[] = []; const tickets: string[] = [];
  for (const stack of candidates) {
    if (stackComplete(stack, unitById, states)) continue;
    const blocker = externalStackBlocker(stack, unitById, defs, states);
    if (blocker) { if (stack === firstPartial) return { stacks: [], tickets: [], error: `partial stack ${stack.id} is blocked by ${blocker}` }; continue; }
    selected.push(stack);
    for (const unitId of stack.units) for (const id of unitById.get(unitId)?.tickets ?? []) if (!terminalDelivery(states.get(id)?.status)) tickets.push(id);
    if (selected.length === count) break;
  }
  if (selected.length !== count) return { stacks: [], tickets: [], error: `requested exactly ${count} complete eligible stack(s), but only ${selected.length} can legally run` };
  return { stacks: selected, tickets };
}

export function updateStackDeliveryState(projectDir: string, stackIds: readonly string[], status: StackDeliveryState, patch: Partial<DeliveryStack> = {}): DeliveryConfig {
  const config = loadDeliveryConfig(projectDir); if (!config) throw new Error(`${DELIVERY_FILE} not found`);
  const selected = new Set(stackIds); let matched = 0;
  const next: DeliveryConfig = { ...config, stacks: (config.stacks ?? []).map((stack) => selected.has(stack.id) ? (matched++, { ...stack, ...patch, id: stack.id, name: stack.name, units: stack.units, status }) : stack) };
  if (matched !== selected.size) throw new Error(`unknown stack IDs: ${[...selected].filter((id) => !next.stacks?.some((stack) => stack.id === id)).join(",")}`);
  const target = join(projectDir, DELIVERY_FILE); const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, stringify(next, { lineWidth: 120 }), "utf8"); renameSync(temp, target); return next;
}

function terminalDelivery(status: string | undefined): boolean { return status === "done" || status === "canceled" || status === "obsolete"; }
function stackStarted(stack: DeliveryStack, units: Map<string, DeliveryUnit>, states: Map<string, TicketState>): boolean { return stack.units.some((unit) => (units.get(unit)?.tickets ?? []).some((id) => ["in_progress", "blocked", "done"].includes(states.get(id)?.status ?? "planned"))); }
function stackComplete(stack: DeliveryStack, units: Map<string, DeliveryUnit>, states: Map<string, TicketState>): boolean { return stack.units.every((unit) => (units.get(unit)?.tickets ?? []).every((id) => terminalDelivery(states.get(id)?.status))); }
function externalStackBlocker(stack: DeliveryStack, units: Map<string, DeliveryUnit>, defs: Map<string, TicketDef>, states: Map<string, TicketState>): string | undefined {
  const inside = new Set(stack.units.flatMap((unit) => units.get(unit)?.tickets ?? []));
  for (const id of inside) for (const dep of defs.get(id)?.depends_on ?? []) if (!inside.has(dep) && !terminalDelivery(states.get(dep)?.status)) return dep;
  return undefined;
}
