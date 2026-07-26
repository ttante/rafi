import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { DateTime } from "luxon";
import type { TicketsConfig } from "./config.js";
import type { TicketDef } from "./ticketSchema.js";
import type { StateDb, TicketState } from "./stateDb.js";
import { buildNextQueue, buildActiveStatusRows } from "./queue.js";
import { resolveBlockers } from "./blockers.js";

// ── Table helpers ─────────────────────────────────────────────────────────────

function esc(v: string): string {
  return v.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function table(headers: string[], rows: string[][]): string {
  const sep = `|${headers.map(() => "---").join("|")}|`;
  const head = `| ${headers.join(" | ")} |`;
  const body = rows.map((r) => `| ${r.map(esc).join(" | ")} |`).join("\n");
  return body ? `${head}\n${sep}\n${body}` : `${head}\n${sep}`;
}

// ── Section helpers ───────────────────────────────────────────────────────────

function section(marker: string, content: string): string {
  return `<!-- ${marker}_START -->\n${content}\n<!-- ${marker}_END -->`;
}

// ── Default tracker-rules content ─────────────────────────────────────────────

export function renderTrackerRules(progressDoc = "docs/ticket-progress.md"): string {
  return `# Tracker Rules

## Purpose
This tracker is the operational build control surface for humans and builder agents.

## First file to read
Read \`${progressDoc}\` first. Do not scan the full backlog to choose work
unless the queue is empty or the user explicitly asks for broader planning.

## How to choose work
Choose the first row in \`LLM_NEXT_QUEUE\` where \`Status\` is \`next\` and \`Blocked By\` is \`None\`.

## Required queue maintenance rule
Every ticket update must regenerate \`${progressDoc}\`, including \`LLM_NEXT_QUEUE\`.
Use \`foreman tickets update <id>\` — never manually edit generated sections.

## Blocked work
Do not implement blocked rows unless the blocker itself is the approved next work.

## Done policy
Never mark a ticket \`done\` without required validation evidence or a documented test exception.
Use \`foreman tickets complete <id> --validation-result passed --evidence "..."\`.

## New work policy
Newly discovered work belongs in the Discovered Future Work Inbox.
Use \`foreman tickets discover --summary "..." --rationale "..."\`.

## Generated document policy
Do not manually edit generated sections of \`${progressDoc}\`.
Use the \`foreman tickets\` commands instead.

## STEP_STATUS protocol
When Foreman is running this project, include the ticket ID in your done marker:
  STEP_STATUS: done | ticket="T001" summary="implemented the feature"
Use \`foreman tickets discover\` for newly discovered work during a build run.
`;
}

export const DEFAULT_TRACKER_RULES = renderTrackerRules();

// ── Main renderer ─────────────────────────────────────────────────────────────

export interface RenderInput {
  config: TicketsConfig;
  projectDir: string;
  ticketDefs: TicketDef[];
  states: Map<string, TicketState>;
  db: StateDb;
  now?: string;
}

export function renderProgressDoc(input: RenderInput): string {
  const { config, projectDir, ticketDefs, states, db } = input;
  const now = input.now ?? DateTime.now().setZone(config.timezone).toISO()!;

  const queueRows = buildNextQueue(ticketDefs, states, config.implementationLimit);
  const activeRows = buildActiveStatusRows(queueRows, ticketDefs, states);
  const futureWork = db.getFutureWork();
  const recentEvents = db.getRecentEvents(config.rendering.maxWorkLogRows);
  const lastSnap = db.getRecentValidationSnapshot();
  const recentCompleted = db.getRecentCompleted();
  const archiveIndex = db.getArchiveIndex();
  const pendingRecommendations = db.getReviewRecommendations("pending");

  const rulesPath = join(projectDir, config.paths.trackerRules);
  const rulesContent = existsSync(rulesPath)
    ? readFileSync(rulesPath, "utf8").trim()
    : renderTrackerRules(config.paths.progressDoc).trim();

  const lines: string[] = [];

  // Header
  lines.push("# Ticket Progress Tracker");
  lines.push("");
  if (config.rendering.generatedDocWarning) {
    lines.push("> Generated file. Do not manually edit generated sections. Use `foreman tickets` commands.");
    lines.push("");
  }

  // Tracker Metadata
  lines.push("## Tracker Metadata");
  lines.push(section("TRACKER_METADATA", table(
    ["Field", "Value"],
    [
      ["App", config.appName],
      ["Implementation Limit", String(config.implementationLimit)],
      ["View Limit", String(config.viewLimit)],
      ["Timezone", config.timezone],
      ["Generated At", now],
      ["Remaining Tickets", String(queueRows.length > 0 ? "≥" + queueRows.length : "0")],
    ],
  )));
  lines.push("");

  // Rules
  if (config.rendering.includeRulesInProgressDoc) {
    lines.push(rulesContent);
    lines.push("");
  }

  // LLM_NEXT_QUEUE
  lines.push("## LLM_NEXT_QUEUE");
  const queueTableContent = queueRows.length === 0
    ? "_No remaining tickets. All work is complete or no tickets have been defined._"
    : table(
        ["Rank", "Ticket", "Title", "Status", "Priority", "Area", "Depends On", "Blocked By",
         "Size", "Risk", "Next Action", "Required Tests", "Evidence", "Likely Files"],
        queueRows.map((r) => [
          String(r.rank), r.ticket, r.title, r.status, r.priority, r.area,
          r.dependsOn, r.blockedBy, r.size, r.risk, r.nextAction,
          r.requiredTests, r.evidence, r.likelyFiles,
        ]),
      );
  lines.push(section("LLM_NEXT_QUEUE", queueTableContent));
  lines.push("");

  // Active Ticket Status
  lines.push("## Active Ticket Status");
  const activeContent = activeRows.length === 0
    ? "_No active tickets._"
    : table(
        ["Ticket", "Title", "Status", "Priority", "Area", "Owner", "last_worked_at",
         "completed_at", "Depends On", "Blockers", "Next Action", "Acceptance / Test Gate",
         "Evidence", "Future Work / Notes"],
        activeRows.map((r) => [
          r.ticket, r.title, r.status, r.priority, r.area, r.owner,
          r.lastWorkedAt, r.completedAt, r.dependsOn, r.blockers, r.nextAction,
          r.acceptanceTestGate, r.evidence, r.futureWorkNotes,
        ]),
      );
  lines.push(section("ACTIVE_TICKET_STATUS", activeContent));
  lines.push("");

  // Blocked Tickets
  const blockedRows = queueRows.filter((r) => r.blockedBy !== "None");
  lines.push("## Blocked Tickets");
  const blockedContent = blockedRows.length === 0
    ? "_No blocked tickets._"
    : table(
        ["Ticket", "Blocked By", "Blocker Type", "Owner", "First Blocked At",
         "Last Checked At", "Needed Decision / Action", "Unblock Criteria", "Notes"],
        blockedRows.map((r) => {
          const state = states.get(r.ticket);
          return [
            r.ticket, r.blockedBy,
            state?.blocker_type ?? "dependency",
            state?.owner ?? "unassigned",
            state?.first_blocked_at ?? "N/A",
            state?.last_checked_at ?? "N/A",
            state?.next_action ?? "Resolve blockers",
            state?.blocker_notes ?? "N/A",
            "N/A",
          ];
        }),
      );
  lines.push(section("BLOCKED_TICKETS", blockedContent));
  lines.push("");

  // Recently Completed Context
  lines.push("## Recently Completed Context");
  const recentCompContent = recentCompleted.length === 0
    ? "_No recently completed tickets pinned for context._"
    : table(
        ["Ticket", "Why It Remains Here", "Pinned Until", "Updated At"],
        recentCompleted.map((r) => [
          r.ticket_id, r.why_it_remains_here, r.pinned_until ?? "N/A", r.updated_at,
        ]),
      );
  lines.push(section("RECENTLY_COMPLETED_CONTEXT", recentCompContent));
  lines.push("");

  // Discovered Future Work Inbox
  lines.push("## Discovered Future Work Inbox");
  const openFutureWork = futureWork.filter((fw) => fw.disposition === "triage");
  const futureContent = openFutureWork.length === 0
    ? "_No discovered future work items._"
    : table(
        ["ID", "Discovered At", "Source Ticket", "Proposed Ticket", "Priority Guess",
         "Area", "Summary", "Rationale", "Needs Decision From", "Disposition"],
        openFutureWork.map((fw) => [
          String(fw.id ?? ""),
          fw.discovered_at,
          fw.source_ticket ?? "N/A",
          fw.proposed_ticket ?? "N/A",
          fw.priority_guess ?? "N/A",
          fw.area ?? "N/A",
          fw.summary,
          fw.rationale ?? "N/A",
          fw.needs_decision_from ?? "N/A",
          fw.disposition,
        ]),
      );
  lines.push(section("DISCOVERED_FUTURE_WORK", futureContent));
  lines.push("");

  // Review Recommendations
  lines.push("## Review Recommendations");
  const recommendationContent = pendingRecommendations.length === 0
    ? "_No pending review recommendations._"
    : table(
        ["ID", "Kind", "Tickets", "Summary", "Rationale"],
        pendingRecommendations.map((rec) => [
          String(rec.id ?? ""),
          rec.kind,
          parseTicketIds(rec.ticket_ids_json).join(", ") || "N/A",
          rec.summary,
          rec.rationale ?? "N/A",
        ]),
      );
  lines.push(section("REVIEW_RECOMMENDATIONS", recommendationContent));
  lines.push("");

  // Archive Index
  lines.push("## Archive Index");
  const archiveContent = archiveIndex.length === 0
    ? "_No archived tickets yet._"
    : table(
        ["Archive File", "Scope", "Last Updated", "Notes"],
        archiveIndex.map((a) => [
          a.archive_file, a.scope, a.last_updated ?? "N/A", a.notes ?? "N/A",
        ]),
      );
  lines.push(section("ARCHIVE_INDEX", archiveContent));
  lines.push("");

  // Last Validation Snapshot
  lines.push("## Last Validation Snapshot");
  const snapRow = lastSnap
    ? [lastSnap.timestamp, lastSnap.scope, lastSnap.result,
       lastSnap.commands ?? "N/A", lastSnap.evidence ?? "N/A", lastSnap.notes ?? "N/A"]
    : ["N/A", "tracker", "not_run", "N/A", "N/A", "No validation snapshots recorded yet."];
  lines.push(table(
    ["Timestamp", "Scope", "Result", "Commands", "Evidence", "Notes"],
    [snapRow],
  ));
  lines.push("");

  // Work Log
  lines.push("## Work Log");
  const workLogContent = recentEvents.length === 0
    ? "_No work log entries yet._"
    : table(
        ["Timestamp", "Actor", "Ticket", "Event", "Old Status", "New Status", "Summary"],
        recentEvents.map((e) => [
          e.timestamp, e.actor ?? "system", e.ticket_id ?? "—",
          e.event_type, e.old_status ?? "—", e.new_status ?? "—", e.summary,
        ]),
      );
  lines.push(section("WORK_LOG", workLogContent));
  lines.push("");

  // Four-Pass Validation Checklist
  lines.push("## Four-Pass Validation Checklist");
  lines.push("");
  lines.push("Run `foreman tickets validate` to execute all passes.");
  lines.push("");
  lines.push("1. **Schema & source** — config.yaml, tickets.yaml schema, unique IDs/orders, valid deps, no cycles.");
  lines.push("2. **State** — SQLite migrations applied, all state ticket_ids exist in tickets.yaml, done tickets have evidence.");
  lines.push("3. **Queue** — correct length, contiguous ranks, no done/canceled, sorted by order, blocked rows marked.");
  lines.push("4. **Generated doc** — required sections and marker comments present, every queued ticket in Active Status.");
  lines.push("");

  return lines.join("\n");
}

function parseTicketIds(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function writeProgressDoc(
  progressDocPath: string,
  content: string,
  atomic: boolean,
): void {
  mkdirSync(dirname(progressDocPath), { recursive: true });
  if (atomic) {
    const tmp = `${progressDocPath}.tmp`;
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, progressDocPath);
  } else {
    writeFileSync(progressDocPath, content, "utf8");
  }
}

export function renderAndWrite(input: RenderInput): void {
  const { config, projectDir } = input;
  const progressDocPath = join(projectDir, config.paths.progressDoc);
  const content = renderProgressDoc(input);
  writeProgressDoc(progressDocPath, content, config.behavior.useAtomicFileWrites);
}
