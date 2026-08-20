import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
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

export interface DeliveryConfig {
  version: 1;
  units: DeliveryUnit[];
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

export function normalizeDeliveryConfig(raw: unknown): DeliveryConfig {
  const value = raw as Record<string, unknown>;
  return {
    version: 1,
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
  };
}

export function validateDeliveryConfig(raw: unknown, ticketDefs?: TicketDef[]): DeliveryIssue[] {
  const issues: DeliveryIssue[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [{ path: "$", message: "expected an object" }];
  const value = raw as Record<string, unknown>;
  if (value.version !== undefined && value.version !== 1) issues.push({ path: "version", message: "expected 1" });
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
  const completedUnits = new Set(config.units.filter((unit) => unit.tickets.every((id) => ["done", "canceled"].includes(states.get(id)?.status ?? "planned"))).map((unit) => unit.id));
  const out: DeliveryUnitProgress[] = [];
  for (const unit of config.units) {
    const remaining = unit.tickets.filter((id) => !["done", "canceled"].includes(states.get(id)?.status ?? "planned"));
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
