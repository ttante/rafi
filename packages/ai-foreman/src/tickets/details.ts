import { existsSync } from "node:fs";
import { loadTicketsConfig, resolveTicketPaths } from "./config.js";
import { loadDeliveryConfig, type DeliveryStack, type DeliveryUnit } from "./delivery.js";
import { resolveBlockers } from "./blockers.js";
import { StateDb, pristineTicketState, type TicketEvent, type TicketState, type ValidationSnapshot } from "./stateDb.js";
import { loadTickets } from "./ticketLoader.js";
import type { TicketDef } from "./ticketSchema.js";

export interface TicketDeliveryDetails {
  units: DeliveryUnit[];
  stacks: DeliveryStack[];
}

export interface TicketDetails {
  definition: TicketDef & Record<string, unknown>;
  state: TicketState;
  effective_blockers: string[];
  validation_history: ValidationSnapshot[];
  events: TicketEvent[];
  delivery: TicketDeliveryDetails;
}

export interface AllTicketDetails {
  version: 1;
  generated_at: string;
  ticket_count: number;
  tickets: TicketDetails[];
}

export function getTicketDetails(projectDir: string, ticketId: string, now = new Date()): TicketDetails {
  const config = loadTicketsConfig(projectDir);
  const paths = resolveTicketPaths(config, projectDir);
  if (!existsSync(paths.tickets)) throw new Error("ticket tracker is not initialized; run `rafi tickets init`");
  const tickets = loadTickets(paths.tickets);
  const definition = tickets.find((ticket) => ticket.id === ticketId) as TicketDetails["definition"] | undefined;
  if (!definition) throw new Error(`Ticket ${ticketId} not found. Run \`rafi tickets queue\` to list tickets.`);
  const db = new StateDb(paths.stateDb);
  try {
    const states = db.getAllStates();
    const state = states.get(ticketId) ?? pristineTicketState(ticketId, now.toISOString());
    const delivery = loadDeliveryConfig(projectDir);
    return assembleTicketDetails(
      definition,
      state,
      states,
      db.getValidationSnapshots(ticketId),
      db.getTicketEvents(ticketId),
      delivery,
    );
  } finally {
    db.close();
  }
}

export function getAllTicketDetails(projectDir: string, now = new Date()): AllTicketDetails {
  const config = loadTicketsConfig(projectDir);
  const paths = resolveTicketPaths(config, projectDir);
  if (!existsSync(paths.tickets)) throw new Error("ticket tracker is not initialized; run `rafi tickets init`");
  const definitions = (loadTickets(paths.tickets) as TicketDetails["definition"][])
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  const generatedAt = now.toISOString();
  const db = new StateDb(paths.stateDb);
  try {
    const states = db.getAllStates();
    const validations = groupByTicketId(db.getValidationSnapshots(), (snapshot) => snapshot.scope);
    const events = groupByTicketId(db.getAllTicketEvents(), (event) => event.ticket_id);
    const delivery = loadDeliveryConfig(projectDir);
    const tickets = definitions.map((definition) => assembleTicketDetails(
      definition,
      states.get(definition.id) ?? pristineTicketState(definition.id, generatedAt),
      states,
      validations.get(definition.id) ?? [],
      events.get(definition.id) ?? [],
      delivery,
    ));
    return { version: 1, generated_at: generatedAt, ticket_count: tickets.length, tickets };
  } finally {
    db.close();
  }
}

function assembleTicketDetails(
  definition: TicketDetails["definition"],
  state: TicketState,
  states: Map<string, TicketState>,
  validationHistory: ValidationSnapshot[],
  events: TicketEvent[],
  delivery: ReturnType<typeof loadDeliveryConfig>,
): TicketDetails {
  const units = delivery?.units.filter((unit) => unit.tickets.includes(definition.id)) ?? [];
  const unitIds = new Set(units.map((unit) => unit.id));
  const stacks = delivery?.stacks?.filter((stack) => stack.units.some((unit) => unitIds.has(unit))) ?? [];
  return {
    definition,
    state,
    effective_blockers: resolveBlockers(definition, states),
    validation_history: validationHistory,
    events,
    delivery: { units, stacks },
  };
}

function groupByTicketId<T>(records: T[], ticketId: (record: T) => string | null): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const record of records) {
    const id = ticketId(record);
    if (id === null) continue;
    const group = grouped.get(id);
    if (group) group.push(record);
    else grouped.set(id, [record]);
  }
  return grouped;
}

export function formatTicketDetails(details: TicketDetails): string[] {
  const lines = [`${details.definition.id}: ${details.definition.title}`, "", "Canonical ticket"];
  const preferred = [
    "id", "order", "title", "area", "priority", "size", "risk", "summary", "depends_on",
    "acceptance", "required_tests", "likely_files", "rollback", "notes", "external_refs",
    "source_refs", "plan_ref", "supersedes", "superseded_by",
  ];
  const keys = [...preferred.filter((key) => key in details.definition), ...Object.keys(details.definition).filter((key) => !preferred.includes(key)).sort()];
  for (const key of keys) lines.push(...formatField(key, details.definition[key]));
  lines.push("", "Active state");
  for (const [key, value] of Object.entries(details.state)) lines.push(...formatField(key, parseJsonField(key, value)));
  lines.push(...formatField("effective_blockers", details.effective_blockers));
  lines.push("", "Active validation and evidence");
  lines.push(...formatField("validation_result", details.state.validation_result));
  lines.push(...formatField("validation_commands", details.state.validation_commands));
  lines.push(...formatField("validation_notes", details.state.validation_notes));
  lines.push(...formatField("evidence", details.state.evidence));
  lines.push("", "Historical validation");
  lines.push(...formatRecords(details.validation_history));
  lines.push("", "Delivery");
  lines.push(...formatField("units", details.delivery.units));
  lines.push(...formatField("stacks", details.delivery.stacks));
  lines.push("", "History");
  lines.push(...formatRecords(details.events));
  return lines;
}

export function formatAllTicketDetails(details: AllTicketDetails): string[] {
  const lines = [`All tickets (${details.ticket_count})`, `Snapshot: ${details.generated_at}`];
  details.tickets.forEach((ticket, index) => {
    lines.push("");
    if (index > 0) lines.push("--------------------------------------------------------------------------------", "");
    lines.push(...formatTicketDetails(ticket));
  });
  return lines;
}

function formatField(label: string, value: unknown): string[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${label}: (none)`];
    if (value.every((item) => typeof item !== "object" || item === null)) {
      return [`${label}:`, ...value.map((item) => `  - ${String(item)}`)];
    }
    return [`${label}:`, ...JSON.stringify(value, null, 2).split("\n").map((line) => `  ${line}`)];
  }
  if (value && typeof value === "object") {
    return [`${label}:`, ...JSON.stringify(value, null, 2).split("\n").map((line) => `  ${line}`)];
  }
  const rendered = value === undefined || value === null || value === "" ? "(none)" : String(value);
  if (!rendered.includes("\n")) return [`${label}: ${rendered}`];
  return [`${label}:`, ...rendered.split("\n").map((line) => `  ${line}`)];
}

function formatRecords(records: unknown[]): string[] {
  return records.length ? JSON.stringify(records, null, 2).split("\n").map((line) => `  ${line}`) : ["  (none)"];
}

function parseJsonField(key: string, value: unknown): unknown {
  if (key !== "blocked_by_json" || typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}
