import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { parse, stringify } from "yaml";
import { Ajv } from "ajv";
import { TICKET_JSON_SCHEMA, type TicketDef } from "./ticketSchema.js";

const ajv = new Ajv({ allErrors: true });
const validateTicketSchema = ajv.compile(TICKET_JSON_SCHEMA);

export function loadTickets(ticketsPath: string): TicketDef[] {
  if (!existsSync(ticketsPath)) return [];
  const raw = parse(readFileSync(ticketsPath, "utf8")) as Record<string, unknown> | null;
  if (!raw || !Array.isArray(raw.tickets)) return [];
  return raw.tickets as TicketDef[];
}

export function saveTickets(ticketsPath: string, tickets: TicketDef[]): void {
  writeFileSync(ticketsPath, stringify({ tickets }, { lineWidth: 120 }), "utf8");
}

export interface ValidationError {
  path: string;
  message: string;
}

export function validateTicketDefs(tickets: TicketDef[]): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const ticket of tickets) {
    if (!validateTicketSchema(ticket as unknown)) {
      for (const err of validateTicketSchema.errors ?? []) {
        errors.push({
          path: `tickets[${ticket.id ?? "?"}]${err.instancePath}`,
          message: err.message ?? "unknown error",
        });
      }
    }
  }

  const ids = new Set<string>();
  for (const t of tickets) {
    if (ids.has(t.id)) {
      errors.push({ path: `tickets[${t.id}]`, message: `duplicate ticket ID: ${t.id}` });
    }
    ids.add(t.id);
  }

  const orders = new Set<number>();
  for (const t of tickets) {
    if (orders.has(t.order)) {
      errors.push({ path: `tickets[${t.id}]`, message: `duplicate order value: ${t.order}` });
    }
    orders.add(t.order);
  }

  for (const t of tickets) {
    for (const dep of t.depends_on) {
      if (!ids.has(dep)) {
        errors.push({ path: `tickets[${t.id}].depends_on`, message: `references unknown ticket: ${dep}` });
      }
    }
    for (const replacement of t.superseded_by ?? []) {
      if (!ids.has(replacement)) errors.push({ path: `tickets[${t.id}].superseded_by`, message: `references unknown ticket: ${replacement}` });
      if (replacement === t.id) errors.push({ path: `tickets[${t.id}].superseded_by`, message: "ticket cannot supersede itself" });
      const reciprocal = tickets.find((candidate) => candidate.id === replacement)?.supersedes ?? [];
      if (ids.has(replacement) && !reciprocal.includes(t.id)) errors.push({ path: `tickets[${t.id}].superseded_by`, message: `${replacement} is missing reciprocal supersedes link to ${t.id}` });
    }
    for (const replaced of t.supersedes ?? []) {
      if (!ids.has(replaced)) errors.push({ path: `tickets[${t.id}].supersedes`, message: `references unknown ticket: ${replaced}` });
      if (replaced === t.id) errors.push({ path: `tickets[${t.id}].supersedes`, message: "ticket cannot supersede itself" });
      const reciprocal = tickets.find((candidate) => candidate.id === replaced)?.superseded_by ?? [];
      if (!reciprocal.includes(t.id)) errors.push({ path: `tickets[${t.id}].supersedes`, message: `${replaced} is missing reciprocal superseded_by link to ${t.id}` });
    }
  }

  for (const t of tickets) {
    if ((t.risk === "Medium" || t.risk === "High") && !t.rollback) {
      errors.push({ path: `tickets[${t.id}]`, message: `${t.risk} risk ticket requires rollback/mitigation notes` });
    }
  }

  return errors;
}

export function detectCycles(tickets: TicketDef[]): string[] {
  const adj = new Map<string, string[]>();
  for (const t of tickets) adj.set(t.id, t.depends_on);

  const visited = new Set<string>();
  const inStack = new Set<string>();
  const cycles: string[] = [];

  function dfs(id: string, path: string[]): void {
    if (inStack.has(id)) {
      const cycleStart = path.indexOf(id);
      cycles.push([...path.slice(cycleStart), id].join(" → "));
      return;
    }
    if (visited.has(id)) return;
    visited.add(id);
    inStack.add(id);
    for (const dep of adj.get(id) ?? []) dfs(dep, [...path, id]);
    inStack.delete(id);
  }

  for (const t of tickets) {
    if (!visited.has(t.id)) dfs(t.id, []);
  }

  return cycles;
}
