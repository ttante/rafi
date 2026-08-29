import type { TicketDef } from "./ticketSchema.js";
import { loadTickets, saveTickets, validateTicketDefs } from "./ticketLoader.js";
import { loadTicketsConfig, resolveTicketPaths } from "./config.js";
import { StateDb, type ReviewRecommendation, type ReviewRecommendationStatus } from "./stateDb.js";
import { nowTimestamp } from "./events.js";
import { renderAndWrite } from "./renderMarkdown.js";
import { createHash } from "node:crypto";

export interface TicketRecommendationPatch {
  add?: TicketDef[];
  update?: Array<{ id: string; set: Partial<TicketDef> }>;
  remove?: string[];
}

export interface CreateRecommendationInput {
  kind: string;
  summary: string;
  rationale?: string | null;
  ticketIds?: string[];
  patch: TicketRecommendationPatch;
  source?: Record<string, unknown>;
}

export interface ReviewCommandOptions {
  action?: "accept" | "dismiss" | "defer";
  ids?: number[];
  all?: boolean;
}

export interface ReviewCommandResult {
  pending: ReviewRecommendation[];
  changed: number;
  action?: "accept" | "dismiss" | "defer";
}

export function createReviewRecommendation(
  db: StateDb,
  now: string,
  input: CreateRecommendationInput,
): number {
  return db.insertReviewRecommendation({
    created_at: now,
    kind: input.kind,
    status: "pending",
    summary: input.summary,
    rationale: input.rationale ?? null,
    ticket_ids_json: JSON.stringify(input.ticketIds ?? []),
    patch_json: JSON.stringify(input.patch),
    source_json: JSON.stringify(input.source ?? {}),
    updated_at: null,
  });
}

export function cmdReviewRecommendations(projectDir: string, opts: ReviewCommandOptions = {}): ReviewCommandResult {
  const config = loadTicketsConfig(projectDir);
  const paths = resolveTicketPaths(config, projectDir);
  const db = new StateDb(paths.stateDb);
  try {
    const pending = db.getReviewRecommendations("pending");
    if (!opts.action) return { pending, changed: 0 };

    const selected = opts.all
      ? pending
      : (opts.ids ?? []).map((id) => {
        const row = db.getReviewRecommendation(id);
        if (!row) throw new Error(`review recommendation ${id} not found`);
        if (row.status !== "pending") throw new Error(`review recommendation ${id} is ${row.status}, not pending`);
        return row;
      });
    if (selected.length === 0) return { pending, changed: 0, action: opts.action };

    const now = nowTimestamp(config.timezone);
    if (opts.action === "accept") {
      const before = loadTickets(paths.tickets);
      db.ensureSyntheticLegacyGroup(before as Array<TicketDef & Record<string, unknown>>);
      let tickets = before;
      const requestedAdditions = new Set<string>();
      for (const rec of selected) {
        const patch = parseRecommendationPatch(rec);
        for (const ticket of patch.add ?? []) requestedAdditions.add(ticket.id);
        tickets = applyRecommendationPatch(tickets, patch);
      }
      const issues = validateTicketDefs(tickets);
      if (issues.length > 0) {
        throw new Error(`accepted recommendation produced invalid tickets:\n${issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n")}`);
      }
      let definitionsPublished = false;
      try {
        db.transaction(() => {
          const additions = tickets.filter((ticket) => requestedAdditions.has(ticket.id) && !db.getTicketGroupForTicket(ticket.id));
          if (additions.length) {
            const operationDigest = createHash("sha256").update(JSON.stringify(selected.map((rec) => rec.id).sort())).digest("hex");
            db.createTicketGroup({ origin: "production", operationId: `recommendations:${operationDigest}`, createdAt: now, members: additions.map((ticket) => ({ ticketId: ticket.id, definition: ticket, validatedAt: now })) });
          }
          saveTickets(paths.tickets, tickets);
          definitionsPublished = true;
          for (const ticket of tickets) if (db.getTicketGroupForTicket(ticket.id)) db.updateTicketDefinitionSnapshot(ticket.id, ticket, now);
          for (const rec of selected) db.updateReviewRecommendationStatus(rec.id!, "accepted", now);
        });
      } catch (error) {
        if (definitionsPublished) saveTickets(paths.tickets, before);
        throw error;
      }
      const states = db.getAllStates();
      renderAndWrite({ config, projectDir, ticketDefs: tickets, states, db });
    } else {
      const status: ReviewRecommendationStatus = opts.action === "defer" ? "deferred" : "dismissed";
      db.transaction(() => {
        for (const rec of selected) db.updateReviewRecommendationStatus(rec.id!, status, now);
      });
      const tickets = loadTickets(paths.tickets);
      const states = db.getAllStates();
      renderAndWrite({ config, projectDir, ticketDefs: tickets, states, db });
    }

    return { pending: db.getReviewRecommendations("pending"), changed: selected.length, action: opts.action };
  } finally {
    db.close();
  }
}

export function applyRecommendationPatch(tickets: TicketDef[], patch: TicketRecommendationPatch): TicketDef[] {
  const byId = new Map(tickets.map((ticket) => [ticket.id, { ...ticket }]));

  for (const id of patch.remove ?? []) {
    if (!byId.has(id)) throw new Error(`patch cannot remove unknown ticket ${id}`);
    byId.delete(id);
  }

  for (const update of patch.update ?? []) {
    const current = byId.get(update.id);
    if (!current) throw new Error(`patch cannot update unknown ticket ${update.id}`);
    byId.set(update.id, {
      ...current,
      ...update.set,
      id: current.id,
      order: update.set.order ?? current.order,
    });
  }

  for (const ticket of patch.add ?? []) {
    if (byId.has(ticket.id)) throw new Error(`patch cannot add duplicate ticket ${ticket.id}`);
    byId.set(ticket.id, { ...ticket });
  }

  return Array.from(byId.values()).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function insertXlSplitRecommendations(projectDir: string, tickets: TicketDef[]): number {
  const config = loadTicketsConfig(projectDir);
  const paths = resolveTicketPaths(config, projectDir);
  const db = new StateDb(paths.stateDb);
  try {
    const now = nowTimestamp(config.timezone);
    const existing = db.getReviewRecommendations().filter((rec) => {
      const ids = parseStringArray(rec.ticket_ids_json);
      return rec.kind === "split" && ids.length === 1;
    });
    let count = 0;
    let nextNumber = nextTicketNumber(tickets);
    const maxOrder = tickets.reduce((highest, ticket) => Math.max(highest, ticket.order), 0);
    for (const ticket of tickets) {
      if (ticket.size !== "XL") continue;
      if (existing.some((rec) => parseStringArray(rec.ticket_ids_json)[0] === ticket.id && rec.status !== "dismissed")) continue;
      const firstId = `T${String(nextNumber++).padStart(3, "0")}`;
      const secondId = `T${String(nextNumber++).padStart(3, "0")}`;
      createReviewRecommendation(db, now, {
        kind: "split",
        summary: `Split XL ticket ${ticket.id}: ${ticket.title}`,
        rationale: "Imported ticket is XL-sized; smaller implementation slices are safer for branch-per-ticket execution.",
        ticketIds: [ticket.id],
        patch: {
          remove: [ticket.id],
          add: [
            {
              ...ticket,
              id: firstId,
              order: maxOrder + count * 2000 + 1000,
              title: `${ticket.title} - implementation slice`,
              size: "L",
              depends_on: ticket.depends_on,
              notes: appendNote(ticket.notes, `Split from ${ticket.id}.`),
            },
            {
              ...ticket,
              id: secondId,
              order: maxOrder + count * 2000 + 2000,
              title: `${ticket.title} - validation slice`,
              size: "M",
              depends_on: [firstId],
              notes: appendNote(ticket.notes, `Split from ${ticket.id}.`),
            },
          ],
        },
        source: { generated_by: "import", original_ticket: ticket.id },
      });
      count++;
    }
    return count;
  } finally {
    db.close();
  }
}

function parseRecommendationPatch(rec: ReviewRecommendation): TicketRecommendationPatch {
  const parsed = JSON.parse(rec.patch_json) as TicketRecommendationPatch;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`review recommendation ${rec.id} has invalid patch_json`);
  }
  return parsed;
}

function parseStringArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function nextTicketNumber(tickets: TicketDef[]): number {
  let max = 0;
  for (const ticket of tickets) {
    const match = /^T(\d+)$/i.exec(ticket.id);
    if (match) max = Math.max(max, Number.parseInt(match[1]!, 10));
  }
  return max + 1;
}

function appendNote(current: string | null | undefined, note: string): string {
  return current?.trim() ? `${current.trim()}\n${note}` : note;
}
