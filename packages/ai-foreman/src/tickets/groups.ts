import { createHash } from "node:crypto";
import type { TicketGroup, TicketGroupId } from "rafi-spec";
import { recoverableBuildRuns } from "../buildRuns.js";
import { loadTicketsConfig, resolveTicketPaths } from "./config.js";
import { StateDb, pristineTicketState, type TicketStatus } from "./stateDb.js";
import { loadTickets } from "./ticketLoader.js";
import type { TicketDef } from "./ticketSchema.js";

export interface TicketGroupListMember {
  ticketId: string;
  position: number;
  definitionMissing: boolean;
  snapshotDigest: string;
  status: TicketStatus;
}
export interface TicketGroupListRow {
  id: TicketGroupId;
  recencyPosition: number;
  origin: TicketGroup["origin"];
  createdAt: string;
  legacy: boolean;
  members: TicketGroupListMember[];
  statusTotals: Partial<Record<TicketStatus, number>>;
  recoverableRuns: Array<{ runId: string; status: string; tickets: string[] }>;
}
export interface TicketGroupListEnvelope { version: 1; generatedAt: string; groups: TicketGroupListRow[] }

export function listTicketGroups(projectDir: string, now = new Date()): TicketGroupListEnvelope {
  const { definitions, db } = open(projectDir);
  try {
    db.ensureSyntheticLegacyGroup(definitions as Array<TicketDef & Record<string, unknown>>, now);
    const current = new Map(definitions.map((definition) => [definition.id, definition]));
    const states = db.getAllStates();
    const runs = recoverableBuildRuns(projectDir, now);
    const groups = db.listTicketGroups().map((group, index): TicketGroupListRow => {
      const members = group.members.map((member) => ({
        ticketId: member.ticketId,
        position: member.position,
        definitionMissing: !current.has(member.ticketId),
        snapshotDigest: member.snapshot.digest,
        status: states.get(member.ticketId)?.status ?? pristineTicketState(member.ticketId, now.toISOString()).status,
      }));
      const memberIds = new Set(members.map((member) => member.ticketId));
      const statusTotals: TicketGroupListRow["statusTotals"] = {};
      for (const member of members) statusTotals[member.status] = (statusTotals[member.status] ?? 0) + 1;
      return {
        id: group.id, recencyPosition: index + 1, origin: group.origin, createdAt: group.createdAt, legacy: group.legacy,
        members, statusTotals,
        recoverableRuns: runs.filter((run) => run.tickets.some((ticket) => memberIds.has(ticket))).map((run) => ({ runId: run.runId, status: run.status, tickets: [...run.tickets] })),
      };
    });
    return { version: 1, generatedAt: now.toISOString(), groups };
  } finally { db.close(); }
}

export interface TicketGroupRepairPreview { version: 1; ticketIds: string[]; inputFingerprint: string }
export function previewTicketGroupRepair(projectDir: string): TicketGroupRepairPreview {
  const { definitions, db } = open(projectDir);
  try {
    db.ensureSyntheticLegacyGroup(definitions as Array<TicketDef & Record<string, unknown>>);
    const ticketIds = db.ungroupedTicketIds(definitions.map((definition) => definition.id));
    return { version: 1, ticketIds, inputFingerprint: repairFingerprint(definitions.filter((definition) => ticketIds.includes(definition.id))) };
  } finally { db.close(); }
}

export function repairTicketGroups(projectDir: string, expectedFingerprint: string, now = new Date()): TicketGroup | undefined {
  const { definitions, db } = open(projectDir);
  try {
    const ticketIds = db.ungroupedTicketIds(definitions.map((definition) => definition.id));
    const selected = definitions.filter((definition) => ticketIds.includes(definition.id));
    const actual = repairFingerprint(selected);
    if (actual !== expectedFingerprint) throw new Error("ticket definitions changed after the repair preview; preview again before approving");
    return db.repairTicketGroups(selected as Array<TicketDef & Record<string, unknown>>, `ticket-groups:repair:${actual}`, now);
  } finally { db.close(); }
}

function repairFingerprint(definitions: TicketDef[]): string {
  return createHash("sha256").update(JSON.stringify(definitions.map((definition) => [definition.id, definition]).sort(([a], [b]) => String(a).localeCompare(String(b))))).digest("hex");
}
function open(projectDir: string): { definitions: TicketDef[]; db: StateDb } {
  const paths = resolveTicketPaths(loadTicketsConfig(projectDir), projectDir);
  return { definitions: loadTickets(paths.tickets), db: new StateDb(paths.stateDb) };
}
