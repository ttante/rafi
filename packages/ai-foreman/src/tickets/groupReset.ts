import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import type { DeletedTicketResetPolicy, RequestedTicketResetTarget, ResolvedTicketResetSelection, TicketGroup, TicketGroupId } from "rafi-spec";
import { recoverableBuildRuns } from "../buildRuns.js";
import { WorkflowDb } from "../workflowDb.js";
import { loadTicketsConfig, resolveTicketPaths } from "./config.js";
import { renderProgressDoc, writeProgressDoc } from "./renderMarkdown.js";
import { StateDb, pristineTicketState, type TicketState, type TicketStatus } from "./stateDb.js";
import { loadTickets, validateTicketDefs } from "./ticketLoader.js";
import type { TicketDef } from "./ticketSchema.js";

export interface ResolveGroupResetOptions {
  deletedTickets?: DeletedTicketResetPolicy;
  perTicket?: Record<string, DeletedTicketResetPolicy>;
  restoreDependencies?: string[];
}
export interface DeletedDependencyConflict { ticketId: string; dependencyId: string }
export class TicketResetDependencyConflictError extends Error {
  constructor(readonly conflicts: DeletedDependencyConflict[]) {
    super(`cannot restore deleted ticket definitions atomically: ${conflicts.map((conflict) => `${conflict.ticketId} depends on missing ${conflict.dependencyId}`).join("; ")}`);
  }
}

const SCOPE_STATUSES: Record<"all" | "completed-and-unfinished" | "unfinished", TicketStatus[]> = {
  all: ["planned", "next", "in_progress", "blocked", "done", "canceled", "obsolete"],
  "completed-and-unfinished": ["planned", "next", "in_progress", "blocked", "done"],
  unfinished: ["planned", "next", "in_progress", "blocked"],
};

/** Resolve a requested target exactly once into immutable groups, rows, and restorations. */
export function resolveTicketResetSelection(
  projectDir: string,
  requested: RequestedTicketResetTarget,
  options: ResolveGroupResetOptions = {},
  now = new Date(),
): ResolvedTicketResetSelection {
  const opened = open(projectDir);
  const { definitions, db } = opened;
  try {
    db.ensureSyntheticLegacyGroup(definitions as Array<TicketDef & Record<string, unknown>>, now);
    const groupCatalog = db.listTicketGroups();
    const groups = selectGroups(groupCatalog, requested);
    const current = new Map(definitions.map((definition) => [definition.id, definition]));
    const snapshots = new Map(groupCatalog.flatMap((group) => group.members.map((member) => [member.ticketId, member.snapshot] as const)));
    const states = db.getAllStates();
    const targetIds = selectTicketIds(requested, groups, definitions, states);
    const selectedGroupIds = new Set(groups.map((group) => group.id));
    const restoreDependencies = new Set(options.restoreDependencies ?? []);
    const definitionRestorations: ResolvedTicketResetSelection["definitionRestorations"] = [];
    const previewRows: ResolvedTicketResetSelection["previewRows"] = [];
    for (const ticketId of targetIds) {
      const definition = current.get(ticketId);
      const snapshot = snapshots.get(ticketId);
      if (!definition && !snapshot) throw new Error(`ticket ${ticketId} is missing and has no valid Rafi definition snapshot`);
      const policy = options.perTicket?.[ticketId] ?? options.deletedTickets ?? "ignore";
      const restore = !definition && policy === "restore";
      if (restore && snapshot) definitionRestorations.push({ ticketId, digest: snapshot.digest, restore: true });
      const display = definition ?? snapshot?.definition as TicketDef | undefined;
      previewRows.push({
        ticketId,
        title: display?.title ?? "(definition unavailable)",
        status: states.get(ticketId)?.status ?? "planned",
        definitionMissing: !definition,
        restoreDefinition: restore,
      });
    }
    for (const dependencyId of restoreDependencies) {
      if (current.has(dependencyId)) continue;
      const snapshot = snapshots.get(dependencyId);
      if (!snapshot) throw new Error(`deleted dependency ${dependencyId} has no valid Rafi definition snapshot`);
      if (!definitionRestorations.some((item) => item.ticketId === dependencyId)) definitionRestorations.push({ ticketId: dependencyId, digest: snapshot.digest, restore: true, dependencyOnly: !targetIds.includes(dependencyId) });
    }
    const restoredIds = new Set(definitionRestorations.filter((item) => item.restore).map((item) => item.ticketId));
    const conflicts: DeletedDependencyConflict[] = [];
    for (const restoration of definitionRestorations.filter((item) => item.restore && !item.dependencyOnly)) {
      const restored = snapshots.get(restoration.ticketId)?.definition as TicketDef;
      for (const dependencyId of restored.depends_on ?? []) {
        if (!current.has(dependencyId) && !restoredIds.has(dependencyId)) conflicts.push({ ticketId: restoration.ticketId, dependencyId });
      }
    }
    if (conflicts.length) throw new TicketResetDependencyConflictError(conflicts);
    const selectedIds = new Set(targetIds);
    const relatedRuns = recoverableBuildRuns(projectDir, now)
      .filter((run) => run.tickets.some((ticketId) => selectedIds.has(ticketId)))
      .map((run) => ({ runId: run.runId, status: run.status, tickets: [...run.tickets] }));
    const base: Omit<ResolvedTicketResetSelection, "inputFingerprint"> = {
      version: 1, requested, resolvedAt: now.toISOString(),
      groups: groups.map((group) => ({ id: group.id, sequence: group.sequence, memberTicketIds: group.members.map((member) => member.ticketId) })),
      ticketIds: targetIds,
      previewRows,
      definitionRestorations,
      relatedRuns,
    };
    return { ...base, inputFingerprint: selectionFingerprint(base, current, states, snapshots, groupCatalog) };
  } finally { db.close(); }
}

export function applyResolvedTicketReset(
  projectDir: string,
  selection: ResolvedTicketResetSelection,
  actor = "user",
  now = new Date(),
  hooks: { beforePublish?: () => void; resetId?: string } = {},
): { resetId: string; tickets: string[]; restored: string[]; ignoredMissing: string[] } {
  const opened = open(projectDir);
  const { config, paths, definitions, db } = opened;
  const workflow = new WorkflowDb(projectDir);
  const resetId = hooks.resetId ?? randomUUID();
  const current = new Map(definitions.map((definition) => [definition.id, definition]));
  const groupCatalog = db.listTicketGroups();
  const snapshots = new Map(groupCatalog.flatMap((group) => group.members.map((member) => [member.ticketId, member.snapshot] as const)));
  const states = db.getAllStates();
  const selectedIds = new Set(selection.ticketIds);
  const currentRelatedRuns = recoverableBuildRuns(projectDir, now)
    .filter((run) => run.tickets.some((ticketId) => selectedIds.has(ticketId)))
    .map((run) => ({ runId: run.runId, status: run.status, tickets: [...run.tickets] }));
  const comparable: Omit<ResolvedTicketResetSelection, "inputFingerprint"> = { ...selection, relatedRuns: currentRelatedRuns };
  delete (comparable as Partial<ResolvedTicketResetSelection>).inputFingerprint;
  const actualFingerprint = selectionFingerprint(comparable, current, states, snapshots, groupCatalog);
  if (actualFingerprint !== selection.inputFingerprint) {
    db.close(); workflow.close();
    throw new Error("ticket/group/reset inputs changed after preview; no reset was applied—preview the exact selection again");
  }
  const restore = selection.definitionRestorations.filter((item) => item.restore);
  const restored = restore.map((item) => item.ticketId);
  const restoredSet = new Set(restored);
  const restoredDefinitions = restore.map((item) => snapshots.get(item.ticketId)?.definition as TicketDef);
  if (restoredDefinitions.some((item) => !item)) { db.close(); workflow.close(); throw new Error("a selected definition snapshot became unavailable"); }
  const nextDefinitions = [...definitions, ...restoredDefinitions.filter((definition) => !current.has(definition.id))].sort((a, b) => a.order - b.order);
  const definitionIssues = validateTicketDefs(nextDefinitions);
  if (definitionIssues.length) { db.close(); workflow.close(); throw new Error(`restored ticket definitions are invalid: ${definitionIssues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`); }
  const resettable = selection.ticketIds.filter((ticketId) => current.has(ticketId) || restoredSet.has(ticketId));
  const ignoredMissing = selection.ticketIds.filter((ticketId) => !current.has(ticketId) && !restoredSet.has(ticketId));
  if (resettable.length === 0 && restored.length === 0) { db.close(); workflow.close(); return { resetId, tickets: [], restored: [], ignoredMissing }; }

  const stageDir = join(projectDir, ".rafi", "reset-stage", resetId);
  const stagedDefinitions = join(stageDir, "tickets.yaml");
  const stagedProgress = join(stageDir, "progress.md");
  const definitionsBefore = existsSync(paths.tickets) ? readFileSync(paths.tickets) : undefined;
  const progressBefore = existsSync(paths.progressDoc) ? readFileSync(paths.progressDoc) : undefined;
  const oldStates = new Map([...new Set([...resettable, ...restored])].map((ticketId) => [ticketId, db.getState(ticketId)]));
  const oldRecent = db.getRecentCompleted().filter((row) => resettable.includes(row.ticket_id));
  const eventIds: number[] = [];
  const run = workflow.createRun({ kind: "recovery", checkpoint: "group-reset-intent", originalWork: selection, remainingWork: { tickets: resettable }, state: { resetId } }, now);
  const publication = workflow.beginPublication(run.runId, { operation: "group-ticket-reset", resetId, selection, stagedDefinitions, stagedProgress, definitionsTarget: paths.tickets, progressTarget: paths.progressDoc }, { definitions: digest(definitionsBefore), progress: digest(progressBefore) }, now);
  try {
    const stamp = now.toISOString();
    db.transaction(() => {
      for (const definition of restoredDefinitions) if (!db.getState(definition.id)) db.upsertState(definition.id, pristineTicketState(definition.id, stamp, actor), stamp);
      for (const row of selection.previewRows) {
        if (!resettable.includes(row.ticketId)) {
          eventIds.push(db.insertEvent({ timestamp: stamp, actor, ticket_id: row.ticketId, event_type: "ticket_reset_skipped_missing", old_status: row.status, new_status: row.status, summary: `Skipped missing definition ${row.ticketId}`, validation: null, evidence: null, payload_json: JSON.stringify({ reset_id: resetId, input_fingerprint: selection.inputFingerprint }) }));
          continue;
        }
        const old = db.getState(row.ticketId)?.status ?? row.status;
        db.upsertState(row.ticketId, pristineTicketState(row.ticketId, stamp, actor), stamp);
        db.deleteRecentCompleted(row.ticketId);
        eventIds.push(db.insertEvent({ timestamp: stamp, actor, ticket_id: row.ticketId, event_type: "ticket_reset", old_status: old, new_status: "planned", summary: `Reset ${row.ticketId} from approved immutable selection`, validation: null, evidence: null, payload_json: JSON.stringify({ reset_id: resetId, groups: selection.groups.map((group) => group.id), restored_definition: restoredSet.has(row.ticketId), input_fingerprint: selection.inputFingerprint }) }));
      }
    });
    mkdirSync(stageDir, { recursive: true });
    writeFileSync(stagedDefinitions, stringify({ tickets: nextDefinitions }, { lineWidth: 120 }), "utf8");
    writeFileSync(stagedProgress, renderProgressDoc({ config, projectDir, ticketDefs: nextDefinitions, states: db.getAllStates(), db, now: stamp }), "utf8");
    workflow.updatePublication(publication.transactionId, "staged", now);
    workflow.updatePublication(publication.transactionId, "tracker_committed", now);
    hooks.beforePublish?.();
    atomicCopy(stagedDefinitions, paths.tickets);
    writeProgressDoc(paths.progressDoc, readFileSync(stagedProgress, "utf8"), true);
    workflow.updatePublication(publication.transactionId, "published", now);
    workflow.updatePublication(publication.transactionId, "committed", now);
    workflow.transition(run.runId, { status: "completed", checkpoint: "group-reset-committed", remainingWork: {}, state: { resetId, tickets: resettable, restored, ignoredMissing } }, now);
    rmSync(stageDir, { recursive: true, force: true });
    return { resetId, tickets: resettable, restored, ignoredMissing };
  } catch (error) {
    db.transaction(() => {
      db.deleteEvents(eventIds);
      for (const [ticketId, state] of oldStates) state ? db.upsertState(ticketId, state, state.updated_at) : db.deleteState(ticketId);
      for (const row of oldRecent) db.upsertRecentCompleted(row);
    });
    restoreFile(paths.tickets, definitionsBefore);
    restoreFile(paths.progressDoc, progressBefore);
    workflow.updatePublication(publication.transactionId, "rolled_back", now);
    workflow.transition(run.runId, { status: "failed", checkpoint: "group-reset-rolled-back", state: { resetId, error: error instanceof Error ? error.message : String(error) } }, now);
    rmSync(stageDir, { recursive: true, force: true });
    throw error;
  } finally { db.close(); workflow.close(); }
}

function selectGroups(groups: TicketGroup[], requested: RequestedTicketResetTarget): TicketGroup[] {
  if (requested.kind === "all-groups") return groups;
  if (requested.kind === "recent-groups") {
    if (!Number.isInteger(requested.count) || requested.count < 1) throw new Error("recent group count must be a positive integer");
    return groups.slice(0, requested.count);
  }
  if (requested.kind === "group") {
    const group = groups.find((candidate) => candidate.id === requested.groupId);
    if (!group) throw new Error(`ticket group ${requested.groupId} not found`);
    return [group];
  }
  if (requested.kind === "group-index") {
    if (!Number.isInteger(requested.position) || requested.position < 1) throw new Error("group index must be a positive 1-based position");
    const group = groups[requested.position - 1];
    if (!group) throw new Error(`ticket group index ${requested.position} not found`);
    return [group];
  }
  return [];
}
function selectTicketIds(requested: RequestedTicketResetTarget, groups: TicketGroup[], definitions: TicketDef[], states: Map<string, TicketState>): string[] {
  if (["all-groups", "recent-groups", "group", "group-index"].includes(requested.kind)) return [...new Set(groups.flatMap((group) => group.members.map((member) => member.ticketId)))];
  if (requested.kind === "ticket") {
    if (!definitions.some((definition) => definition.id === requested.ticketId)) throw new Error(`Ticket ${requested.ticketId} not found. Run \`rafi tickets queue\` to list tickets.`);
    return [requested.ticketId];
  }
  if (requested.kind === "run") {
    const known = new Set(definitions.map((definition) => definition.id));
    const missing = requested.ticketIds.filter((ticketId) => !known.has(ticketId));
    if (missing.length) throw new Error(`Tickets not found: ${missing.join(", ")}`);
    return [...new Set(requested.ticketIds)];
  }
  if (requested.kind !== "scope") throw new Error(`unsupported reset target: ${requested.kind}`);
  const statuses = new Set(SCOPE_STATUSES[requested.scope]);
  return definitions.filter((definition) => statuses.has(states.get(definition.id)?.status ?? "planned")).map((definition) => definition.id);
}
function selectionFingerprint(
  base: Omit<ResolvedTicketResetSelection, "inputFingerprint">,
  definitions: Map<string, TicketDef>,
  states: Map<string, TicketState>,
  snapshots: Map<string, { digest: string }>,
  groups: TicketGroup[],
): string {
  const relevant = [...new Set([...base.ticketIds, ...base.definitionRestorations.map((item) => item.ticketId)])].sort();
  return hash({
    requested: base.requested,
    groups: base.groups,
    groupCatalog: groups.map((group) => ({
      id: group.id, sequence: group.sequence, origin: group.origin, createdAt: group.createdAt, legacy: group.legacy, operationId: group.operationId,
      members: group.members.map((member) => ({ ticketId: member.ticketId, position: member.position, snapshotDigest: member.snapshot.digest })),
    })),
    definitionCatalog: [...definitions.entries()].sort(([a], [b]) => a.localeCompare(b)),
    tickets: relevant.map((ticketId) => ({ ticketId, definition: definitions.get(ticketId) ?? null, state: states.get(ticketId) ?? null, snapshotDigest: snapshots.get(ticketId)?.digest ?? null })),
    relatedRuns: base.relatedRuns,
    restorations: base.definitionRestorations,
  });
}
function open(projectDir: string) {
  const config = loadTicketsConfig(projectDir); const paths = resolveTicketPaths(config, projectDir);
  return { config, paths, definitions: loadTickets(paths.tickets), db: new StateDb(paths.stateDb) };
}
function hash(value: unknown): string { return createHash("sha256").update(stableJson(value)).digest("hex"); }
function digest(value: Buffer | undefined): string | null { return value ? createHash("sha256").update(value).digest("hex") : null; }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function atomicCopy(source: string, target: string): void { mkdirSync(dirname(target), { recursive: true }); const temp = `${target}.${process.pid}.${randomUUID()}.tmp`; writeFileSync(temp, readFileSync(source)); renameSync(temp, target); }
function restoreFile(path: string, value: Buffer | undefined): void { if (value) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); } else rmSync(path, { force: true }); }
