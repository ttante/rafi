import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { recoverableBuildRuns } from "../buildRuns.js";
import { WorkflowDb, WORKFLOW_DB_FILE } from "../workflowDb.js";
import { loadTicketsConfig, resolveTicketPaths } from "./config.js";
import { renderProgressDoc, writeProgressDoc } from "./renderMarkdown.js";
import { StateDb, pristineTicketState, type TicketState, type TicketStatus } from "./stateDb.js";
import { loadTickets } from "./ticketLoader.js";
import type { TicketDef } from "./ticketSchema.js";

export type TicketResetScope = "all" | "completed-and-unfinished" | "unfinished";
export interface TicketResetPreviewRow {
  id: string;
  title: string;
  status: TicketStatus;
  cleared: string[];
}
export interface TicketResetPreview {
  scope: TicketResetScope | "single" | "run";
  tickets: TicketResetPreviewRow[];
  relatedRuns: Array<{ runId: string; status: string; tickets: string[] }>;
}

const SCOPE_STATUSES: Record<TicketResetScope, TicketStatus[]> = {
  all: ["planned", "next", "in_progress", "blocked", "done", "canceled", "obsolete"],
  "completed-and-unfinished": ["planned", "next", "in_progress", "blocked", "done"],
  unfinished: ["planned", "next", "in_progress", "blocked"],
};

export function previewTicketReset(projectDir: string, target: string | TicketResetScope | string[]): TicketResetPreview {
  const { tickets, db } = open(projectDir);
  try {
    const states = db.getAllStates();
    let selected: TicketDef[];
    let scope: TicketResetPreview["scope"];
    if (Array.isArray(target)) {
      scope = "run";
      const wanted = new Set(target);
      selected = tickets.filter((ticket) => wanted.has(ticket.id));
      const missing = target.filter((id) => !selected.some((ticket) => ticket.id === id));
      if (missing.length) throw new Error(`Tickets not found: ${missing.join(", ")}`);
    } else if (target in SCOPE_STATUSES) {
      scope = target as TicketResetScope;
      const statuses = new Set(SCOPE_STATUSES[scope]);
      selected = tickets.filter((ticket) => statuses.has(states.get(ticket.id)?.status ?? "planned"));
    } else {
      scope = "single";
      const ticket = tickets.find((candidate) => candidate.id === target);
      if (!ticket) throw new Error(`Ticket ${target} not found. Run \`rafi tickets queue\` to list tickets.`);
      selected = [ticket];
    }
    const selectedIds = new Set(selected.map((ticket) => ticket.id));
    const relatedRuns = recoverableBuildRuns(projectDir)
      .filter((run) => run.tickets.some((id) => selectedIds.has(id)))
      .map((run) => ({ runId: run.runId, status: run.status, tickets: run.tickets }));
    return {
      scope,
      tickets: selected.map((ticket) => {
        const state = states.get(ticket.id) ?? pristineTicketState(ticket.id, new Date(0).toISOString());
        return { id: ticket.id, title: ticket.title, status: state.status, cleared: activeFieldCategories(state) };
      }),
      relatedRuns,
    };
  } finally { db.close(); }
}

export function resetTickets(
  projectDir: string,
  target: string | TicketResetScope | string[],
  actor = "user",
  now = new Date(),
  hooks: { beforePublish?: () => void; resetId?: string } = {},
): { resetId: string; tickets: string[] } {
  const preview = previewTicketReset(projectDir, target);
  const ids = preview.tickets.map((ticket) => ticket.id);
  if (ids.length === 0) return { resetId: randomUUID(), tickets: [] };
  const { config, paths, tickets, db } = open(projectDir);
  const workflow = new WorkflowDb(projectDir);
  const resetId = hooks.resetId ?? randomUUID();
  if (ids.every((id) => db.getTicketEvents(id).some((event) => event.event_type === "ticket_reset" && event.payload_json?.includes(resetId)))) {
    workflow.close();
    db.close();
    return { resetId, tickets: ids };
  }
  const stagePath = join(projectDir, ".rafi", "reset-stage", resetId, "progress.md");
  const oldStates = new Map(ids.map((id) => [id, db.getState(id)]));
  const oldRecentCompleted = db.getRecentCompleted().filter((row) => ids.includes(row.ticket_id));
  const insertedEventIds: number[] = [];
  const progressBefore = existsSync(paths.progressDoc) ? readFileSync(paths.progressDoc) : undefined;
  const run = workflow.createRun({
    kind: "recovery",
    checkpoint: "ticket-reset-intent",
    originalWork: { resetId, scope: preview.scope, tickets: ids, states: Object.fromEntries(oldStates) },
    remainingWork: { tickets: ids },
    state: { operation: "ticket-reset", progressDigest: digest(progressBefore) },
  }, now);
  const publication = workflow.beginPublication(run.runId, { operation: "ticket-reset", resetId, tickets: ids, stagePath, targetPath: paths.progressDoc }, { progressDigest: digest(progressBefore) }, now);
  try {
    const stamp = now.toISOString();
    db.transaction(() => {
      for (const row of preview.tickets) {
        db.upsertState(row.id, pristineTicketState(row.id, stamp, actor), stamp);
        db.deleteRecentCompleted(row.id);
        insertedEventIds.push(db.insertEvent({
          timestamp: stamp,
          actor,
          ticket_id: row.id,
          event_type: "ticket_reset",
          old_status: row.status,
          new_status: "planned",
          summary: `Reset ${row.id} to pristine active state`,
          validation: null,
          evidence: null,
          payload_json: JSON.stringify({ reset_id: resetId, scope: preview.scope, cleared: row.cleared }),
        }));
      }
    });
    mkdirSync(dirname(stagePath), { recursive: true });
    writeFileSync(stagePath, renderProgressDoc({ config, projectDir, ticketDefs: tickets, states: db.getAllStates(), db, now: stamp }), "utf8");
    workflow.updatePublication(publication.transactionId, "staged", now);
    workflow.updatePublication(publication.transactionId, "tracker_committed", now);
    hooks.beforePublish?.();
    writeProgressDoc(paths.progressDoc, readFileSync(stagePath, "utf8"), true);
    workflow.updatePublication(publication.transactionId, "published", now);
    workflow.updatePublication(publication.transactionId, "committed", now);
    workflow.transition(run.runId, { status: "completed", checkpoint: "ticket-reset-committed", remainingWork: {}, state: { operation: "ticket-reset", resetId, tickets: ids } }, now);
    rmSync(dirname(stagePath), { recursive: true, force: true });
    return { resetId, tickets: ids };
  } catch (error) {
    db.transaction(() => {
      db.deleteEvents(insertedEventIds);
      for (const [id, state] of oldStates) {
        if (state) db.upsertState(id, state, state.updated_at);
        else db.deleteState(id);
      }
      for (const row of oldRecentCompleted) db.upsertRecentCompleted(row);
    });
    if (progressBefore) writeProgressDoc(paths.progressDoc, progressBefore.toString("utf8"), true);
    else rmSync(paths.progressDoc, { force: true });
    rmSync(dirname(stagePath), { recursive: true, force: true });
    workflow.updatePublication(publication.transactionId, "rolled_back", now);
    workflow.transition(run.runId, { status: "failed", checkpoint: "ticket-reset-rolled-back", state: { operation: "ticket-reset", resetId, error: error instanceof Error ? error.message : String(error) } }, now);
    throw error;
  } finally {
    workflow.close();
    db.close();
  }
}

/** Finish or roll back a reset publication left incomplete by process interruption. */
export function recoverTicketResetPublications(projectDir: string): string[] {
  if (!existsSync(join(projectDir, WORKFLOW_DB_FILE))) return [];
  const workflow = new WorkflowDb(projectDir);
  const recovered: string[] = [];
  try {
    for (const tx of workflow.incompletePublications()) {
      const intent = tx.intent as { operation?: string; resetId?: string; tickets?: string[]; stagePath?: string; targetPath?: string };
      if (intent.operation !== "ticket-reset" || !intent.resetId || !intent.tickets || !intent.stagePath || !intent.targetPath) continue;
      const { config, tickets, db } = open(projectDir);
      try {
        const resetCommitted = intent.tickets.every((id) => db.getTicketEvents(id).some((event) => event.event_type === "ticket_reset" && event.payload_json?.includes(intent.resetId!)));
        if (resetCommitted || ["staged", "tracker_committed", "published"].includes(tx.status)) {
          if (!existsSync(intent.stagePath)) {
            mkdirSync(dirname(intent.stagePath), { recursive: true });
            writeFileSync(intent.stagePath, renderProgressDoc({ config, projectDir, ticketDefs: tickets, states: db.getAllStates(), db }), "utf8");
          }
          if (tx.status !== "published") writeProgressDoc(intent.targetPath, readFileSync(intent.stagePath, "utf8"), true);
          workflow.updatePublication(tx.transactionId, "committed");
          const run = workflow.getRun(tx.runId);
          if (run && run.status !== "completed") workflow.transition(run.runId, { status: "completed", checkpoint: "ticket-reset-recovered", remainingWork: {}, state: { ...run.state, recoveredPublication: tx.transactionId } });
        } else {
          workflow.updatePublication(tx.transactionId, "rolled_back");
        }
        rmSync(dirname(intent.stagePath), { recursive: true, force: true });
        recovered.push(tx.transactionId);
      } finally { db.close(); }
    }
    return recovered;
  } finally { workflow.close(); }
}

function open(projectDir: string) {
  const config = loadTicketsConfig(projectDir);
  const paths = resolveTicketPaths(config, projectDir);
  const tickets = loadTickets(paths.tickets);
  const db = new StateDb(paths.stateDb);
  return { config, paths, tickets, db };
}

function activeFieldCategories(state: TicketState): string[] {
  const out: string[] = [];
  if (state.status !== "planned") out.push("status");
  if (state.owner) out.push("owner");
  if (state.current_step || state.next_action) out.push("steps");
  if (state.blocked_by_json !== "[]" || state.blocker_type || state.blocker_notes || state.first_blocked_at || state.last_checked_at) out.push("temporary blockers");
  if (state.last_worked_at || state.completed_at) out.push("work timestamps");
  if (state.attempt_count) out.push("attempt count");
  if (state.last_error) out.push("last error");
  if (state.evidence || state.validation_result || state.validation_commands || state.validation_notes) out.push("active validation/evidence");
  return out.length ? out : ["no active progress"];
}

function digest(value: Buffer | undefined): string | null {
  return value ? createHash("sha256").update(value).digest("hex") : null;
}

export {
  applyResolvedTicketReset,
  resolveTicketResetSelection,
  TicketResetDependencyConflictError,
  type DeletedDependencyConflict,
  type ResolveGroupResetOptions,
} from "./groupReset.js";
