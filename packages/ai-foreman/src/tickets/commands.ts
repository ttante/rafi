import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import type { TicketDef } from "./ticketSchema.js";
import type { ValidationResult } from "./stateDb.js";
import {
  DEFAULT_TICKETS_CONFIG,
  type TicketsConfig,
  initDocsRoot,
  loadTicketsConfig,
  pathExistsOrSymlink,
  resolveTicketPaths,
  isTicketsInitialized,
} from "./config.js";
import { loadTickets, saveTickets } from "./ticketLoader.js";
import { StateDb } from "./stateDb.js";
import { nowTimestamp, logEvent } from "./events.js";
import { renderAndWrite, renderTrackerRules } from "./renderMarkdown.js";
import { runAllValidation } from "./validate.js";
import { buildNextQueue, formatStackAwareQueue } from "./queue.js";
import { loadDeliveryConfig, saveDeliveryConfig } from "./delivery.js";
import { checkGitHubPrMerged } from "../branch/github.js";
import { checkGitLabMrMerged } from "../branch/gitlab.js";
import { cmdReviewRecommendations, type ReviewCommandOptions, type ReviewCommandResult } from "./recommendations.js";

// ── Context helper ────────────────────────────────────────────────────────────

export interface TicketContext {
  config: TicketsConfig;
  projectDir: string;
  paths: ReturnType<typeof resolveTicketPaths>;
  tickets: TicketDef[];
  db: StateDb;
}

export function openContext(projectDir: string): TicketContext {
  const config = loadTicketsConfig(projectDir);
  const paths = resolveTicketPaths(config, projectDir);
  const tickets = loadTickets(paths.tickets);
  const db = new StateDb(paths.stateDb);
  return { config, projectDir, paths, tickets, db };
}

function withContext<T>(projectDir: string, fn: (ctx: TicketContext) => T): T {
  const ctx = openContext(projectDir);
  try {
    return fn(ctx);
  } finally {
    ctx.db.close();
  }
}

function renderAfterUpdate(ctx: TicketContext): void {
  const states = ctx.db.getAllStates();
  renderAndWrite({ config: ctx.config, projectDir: ctx.projectDir, ticketDefs: ctx.tickets, states, db: ctx.db });
}

// ── init ──────────────────────────────────────────────────────────────────────

export interface InitOptions {
  appName?: string;
  timezone?: string;
  implementationLimit?: number;
  viewLimit?: number;
  /** @deprecated Use implementationLimit. */
  queueLimit?: number;
  docsRoot?: string;
}

export function cmdInit(projectDir: string, opts: InitOptions): void {
  if (isTicketsInitialized(projectDir)) {
    throw new Error(".tickets/config.yaml already exists — already initialized.");
  }
  if (opts.implementationLimit !== undefined && opts.queueLimit !== undefined) {
    throw new Error("--implementation-limit and deprecated --queue-limit cannot both be set");
  }

  const ticketsDir = join(projectDir, ".tickets");
  const docsRoot = initDocsRoot(projectDir, opts.docsRoot);
  const progressDoc = `${docsRoot}/ticket-progress.md`;
  const archiveDoc = `${docsRoot}/ticket-archive.md`;
  if (pathExistsOrSymlink(join(projectDir, progressDoc))) {
    throw new Error(
      `${progressDoc} already exists. Choose another docs root with --docs-root <dir> ` +
      "or move the existing progress doc before initializing tickets.",
    );
  }

  mkdirSync(join(ticketsDir, "schema"), { recursive: true });
  mkdirSync(join(ticketsDir, "migrations"), { recursive: true });
  mkdirSync(join(ticketsDir, "backups"), { recursive: true });
  mkdirSync(join(projectDir, docsRoot), { recursive: true });

  const config = {
    app_name: opts.appName ?? "My App",
    implementation_limit: opts.implementationLimit ?? opts.queueLimit ?? DEFAULT_TICKETS_CONFIG.implementationLimit,
    view_limit: opts.viewLimit ?? DEFAULT_TICKETS_CONFIG.viewLimit,
    timezone: opts.timezone ?? "UTC",
    timestamp_format: "iso8601_offset",
    paths: {
      tickets: ".tickets/tickets.yaml",
      state_db: ".tickets/ticket-state.sqlite",
      tracker_rules: ".tickets/tracker-rules.md",
      progress_doc: progressDoc,
      archive_doc: archiveDoc,
    },
    rendering: {
      preserve_legacy_llm_queue_heading: true,
      include_rules_in_progress_doc: true,
      max_work_log_rows: 50,
      max_validation_snapshot_rows: 20,
      max_recent_completed_rows: 20,
      generated_doc_warning: true,
    },
    behavior: {
      regenerate_progress_doc_after_every_update: true,
      require_validation_evidence_for_done: true,
      block_on_unresolved_dependencies: true,
      use_atomic_file_writes: true,
      backup_before_import_or_migration: true,
    },
  };
  writeFileSync(join(ticketsDir, "config.yaml"), stringify(config, { lineWidth: 80 }), "utf8");

  writeFileSync(join(ticketsDir, "tickets.yaml"), "tickets: []\n", "utf8");
  writeFileSync(
    join(ticketsDir, ".gitignore"),
    [
      "imports/",
      "ticket-state.sqlite",
      "ticket-state.sqlite-shm",
      "ticket-state.sqlite-wal",
      "backups/",
      "",
    ].join("\n"),
    "utf8",
  );

  writeFileSync(join(ticketsDir, "tracker-rules.md"), renderTrackerRules(progressDoc), "utf8");

  const ticketSchema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "Ticket",
    type: "object",
    required: ["id", "order", "title", "area", "priority", "size", "risk",
               "depends_on", "summary", "acceptance", "required_tests", "likely_files"],
    properties: {
      id: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9-_]*$" },
      order: { type: "number", minimum: 0 },
      title: { type: "string" },
      area: { type: "string" },
      priority: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
      size: { type: "string", enum: ["XS", "S", "M", "L", "XL"] },
      risk: { type: "string", enum: ["Low", "Medium", "High"] },
      depends_on: { type: "array", items: { type: "string" } },
      summary: { type: "string" },
      acceptance: { type: "array", items: { type: "string" }, minItems: 1 },
      required_tests: { type: "array", items: { type: "string" }, minItems: 1 },
      likely_files: { type: "array", items: { type: "string" } },
      rollback: { type: ["string", "null"] },
      notes: { type: ["string", "null"] },
      external_refs: {
        type: "array",
        items: {
          type: "object",
          required: ["provider", "id"],
          additionalProperties: true,
          properties: {
            provider: { type: "string", minLength: 1 },
            id: { type: "string", minLength: 1 },
            key: { type: ["string", "null"] },
            url: { type: ["string", "null"] },
          },
        },
      },
      source_refs: {
        type: "array",
        items: {
          type: "object",
          required: ["source", "item"],
          properties: {
            source: { type: "string", minLength: 1 },
            item: { type: "string", minLength: 1 },
            source_id: { type: "string", pattern: "^src_[A-Za-z0-9_-]+$" },
            url: { type: ["string", "null"] },
            fingerprint: { type: ["string", "null"] },
            note: { type: ["string", "null"] },
          },
        },
      },
      superseded_by: { type: "array", items: { type: "string" }, uniqueItems: true },
      supersedes: { type: "array", items: { type: "string" }, uniqueItems: true },
    },
  };
  writeFileSync(join(ticketsDir, "schema", "tickets.schema.json"), JSON.stringify(ticketSchema, null, 2), "utf8");

  writeFileSync(join(ticketsDir, "migrations", "001_init.sql"),
    "-- Auto-applied by foreman tickets init via the StateDb class.\n" +
    "-- See src/tickets/stateDb.ts for the full SQL schema.\n",
    "utf8");

  // Open DB (runs migrations), render initial doc, close
  const loadedConfig = loadTicketsConfig(projectDir);
  const paths = resolveTicketPaths(loadedConfig, projectDir);
  const db = new StateDb(paths.stateDb);
  try {
    const states = db.getAllStates();
    renderAndWrite({ config: loadedConfig, projectDir, ticketDefs: [], states, db });
  } finally {
    db.close();
  }
}

// ── update ────────────────────────────────────────────────────────────────────

export interface UpdateOptions {
  status?: string;
  actor?: string;
  summary?: string;
  nextAction?: string;
  currentStep?: string;
  owner?: string;
  validationResult?: ValidationResult;
  validationCommands?: string;
  validationNotes?: string;
  evidence?: string;
  lastError?: string;
}

export function cmdUpdate(projectDir: string, ticketId: string, opts: UpdateOptions): void {
  withContext(projectDir, (ctx) => {
    const now = nowTimestamp(ctx.config.timezone);
    const state = ctx.db.getState(ticketId);
    const oldStatus = state?.status ?? null;

    const patch: Record<string, unknown> = { last_worked_at: now };
    if (opts.status) patch.status = opts.status;
    if (opts.nextAction !== undefined) patch.next_action = opts.nextAction;
    if (opts.currentStep !== undefined) patch.current_step = opts.currentStep;
    if (opts.owner !== undefined) patch.owner = opts.owner;
    if (opts.validationResult !== undefined) patch.validation_result = opts.validationResult;
    if (opts.validationCommands !== undefined) patch.validation_commands = opts.validationCommands;
    if (opts.validationNotes !== undefined) patch.validation_notes = opts.validationNotes;
    if (opts.evidence !== undefined) patch.evidence = opts.evidence;
    if (opts.lastError !== undefined) patch.last_error = opts.lastError;
    if (opts.status === "done" || opts.status === "canceled") patch.completed_at = now;

    ctx.db.transaction(() => {
      ctx.db.upsertState(ticketId, patch, now);
      logEvent(ctx.db, {
        timestamp: now,
        actor: opts.actor ?? null,
        ticketId,
        eventType: "update",
        oldStatus,
        newStatus: opts.status ?? null,
        summary: opts.summary ?? `Updated ticket ${ticketId}`,
      });
    });

    renderAfterUpdate(ctx);
  });
}

// ── complete ──────────────────────────────────────────────────────────────────

export interface CompleteOptions {
  actor?: string;
  summary?: string;
  validationResult?: ValidationResult;
  validationCommands?: string;
  evidence?: string;
  validationNotes?: string;
}

export function cmdComplete(projectDir: string, ticketId: string, opts: CompleteOptions): void {
  withContext(projectDir, (ctx) => {
    const requireEvidence = ctx.config.behavior.requireValidationEvidenceForDone;
    const vr = opts.validationResult ?? "not_run";
    if (requireEvidence && !opts.evidence && vr !== "not_applicable") {
      throw new Error(
        `--evidence is required to mark a ticket done (config.behavior.requireValidationEvidenceForDone=true).\n` +
        `Use --validation-result not_applicable --validation-notes "<reason>" to skip.`,
      );
    }

    const now = nowTimestamp(ctx.config.timezone);
    const state = ctx.db.getState(ticketId);
    const oldStatus = state?.status ?? null;

    ctx.db.transaction(() => {
      ctx.db.upsertState(ticketId, {
        status: "done",
        completed_at: now,
        last_worked_at: now,
        validation_result: vr,
        validation_commands: opts.validationCommands ?? null,
        validation_notes: opts.validationNotes ?? null,
        evidence: opts.evidence ?? null,
        attempt_count: (state?.attempt_count ?? 0) + 1,
      }, now);

      if (opts.validationResult && opts.evidence) {
        ctx.db.insertValidationSnapshot({
          timestamp: now,
          scope: ticketId,
          result: opts.validationResult,
          commands: opts.validationCommands ?? null,
          evidence: opts.evidence,
          notes: opts.validationNotes ?? null,
        });
      }

      logEvent(ctx.db, {
        timestamp: now,
        actor: opts.actor ?? null,
        ticketId,
        eventType: "complete",
        oldStatus,
        newStatus: "done",
        summary: opts.summary ?? `Completed ticket ${ticketId}`,
        validation: opts.validationResult ?? null,
        evidence: opts.evidence ?? null,
      });
    });

    renderAfterUpdate(ctx);
  });
}

// ── block ─────────────────────────────────────────────────────────────────────

export interface BlockOptions {
  blockedBy?: string[];
  blockerType?: string;
  summary?: string;
  actor?: string;
  unblockCriteria?: string;
}

export function cmdBlock(projectDir: string, ticketId: string, opts: BlockOptions): void {
  withContext(projectDir, (ctx) => {
    const now = nowTimestamp(ctx.config.timezone);
    const state = ctx.db.getState(ticketId);
    const oldStatus = state?.status ?? null;
    const existing = JSON.parse(state?.blocked_by_json ?? "[]") as string[];
    const merged = [...new Set([...existing, ...(opts.blockedBy ?? [])])];

    ctx.db.transaction(() => {
      ctx.db.upsertState(ticketId, {
        status: "blocked",
        blocked_by_json: JSON.stringify(merged),
        blocker_type: opts.blockerType ?? "dependency",
        blocker_notes: opts.unblockCriteria ?? null,
        first_blocked_at: state?.first_blocked_at ?? now,
        last_checked_at: now,
        last_worked_at: now,
      }, now);
      logEvent(ctx.db, {
        timestamp: now,
        actor: opts.actor ?? null,
        ticketId,
        eventType: "block",
        oldStatus,
        newStatus: "blocked",
        summary: opts.summary ?? `Blocked ticket ${ticketId} by ${merged.join(", ")}`,
      });
    });

    renderAfterUpdate(ctx);
  });
}

// ── unblock ───────────────────────────────────────────────────────────────────

export function cmdUnblock(
  projectDir: string,
  ticketId: string,
  opts: { summary?: string; actor?: string },
): void {
  withContext(projectDir, (ctx) => {
    const now = nowTimestamp(ctx.config.timezone);
    const state = ctx.db.getState(ticketId);
    const oldStatus = state?.status ?? null;

    ctx.db.transaction(() => {
      ctx.db.upsertState(ticketId, {
        status: "planned",
        blocked_by_json: "[]",
        blocker_type: null,
        blocker_notes: null,
        first_blocked_at: null,
        last_checked_at: null,
        last_worked_at: now,
      }, now);
      logEvent(ctx.db, {
        timestamp: now,
        actor: opts.actor ?? null,
        ticketId,
        eventType: "unblock",
        oldStatus,
        newStatus: "planned",
        summary: opts.summary ?? `Unblocked ticket ${ticketId}`,
      });
    });

    renderAfterUpdate(ctx);
  });
}

// ── cancel ────────────────────────────────────────────────────────────────────

export function cmdCancel(
  projectDir: string,
  ticketId: string,
  opts: { summary: string; actor?: string },
): void {
  withContext(projectDir, (ctx) => {
    const now = nowTimestamp(ctx.config.timezone);
    const state = ctx.db.getState(ticketId);
    const oldStatus = state?.status ?? null;

    ctx.db.transaction(() => {
      ctx.db.upsertState(ticketId, {
        status: "canceled",
        completed_at: now,
        last_worked_at: now,
      }, now);
      logEvent(ctx.db, {
        timestamp: now,
        actor: opts.actor ?? null,
        ticketId,
        eventType: "cancel",
        oldStatus,
        newStatus: "canceled",
        summary: opts.summary,
      });
    });

    renderAfterUpdate(ctx);
  });
}

// ── discover ──────────────────────────────────────────────────────────────────

export interface DiscoverOptions {
  sourceTicket?: string;
  proposedTicket?: string;
  priorityGuess?: string;
  area?: string;
  summary: string;
  rationale?: string;
  needsDecisionFrom?: string;
  actor?: string;
}

export function cmdDiscover(projectDir: string, opts: DiscoverOptions): number {
  return withContext(projectDir, (ctx) => {
    const now = nowTimestamp(ctx.config.timezone);
    let id: number;

    ctx.db.transaction(() => {
      id = ctx.db.insertFutureWork({
        discovered_at: now,
        source_ticket: opts.sourceTicket ?? null,
        proposed_ticket: opts.proposedTicket ?? null,
        priority_guess: opts.priorityGuess ?? null,
        area: opts.area ?? null,
        summary: opts.summary,
        rationale: opts.rationale ?? null,
        needs_decision_from: opts.needsDecisionFrom ?? null,
        disposition: "triage",
      });
      logEvent(ctx.db, {
        timestamp: now,
        actor: opts.actor ?? null,
        ticketId: opts.sourceTicket ?? null,
        eventType: "discover",
        oldStatus: null,
        newStatus: null,
        summary: `Discovered future work: ${opts.summary}`,
      });
    });

    renderAfterUpdate(ctx);
    return id!;
  });
}

// ── accept-future-work ────────────────────────────────────────────────────────

export function cmdAcceptFutureWork(
  projectDir: string,
  futureWorkId: number,
  opts: { ticketId: string; order: number; actor?: string },
): void {
  withContext(projectDir, (ctx) => {
    const fw = ctx.db.getFutureWorkById(futureWorkId);
    if (!fw) throw new Error(`Future work item ${futureWorkId} not found`);

    const now = nowTimestamp(ctx.config.timezone);
    const newTicket: TicketDef = {
      id: opts.ticketId,
      order: opts.order,
      title: fw.summary,
      area: fw.area ?? "General",
      priority: (fw.priority_guess as "P0" | "P1" | "P2" | "P3") ?? "P2",
      size: "M",
      risk: "Low",
      depends_on: [],
      summary: fw.summary,
      acceptance: ["TODO: fill acceptance criteria"],
      required_tests: ["TODO: fill required tests"],
      likely_files: [],
      rollback: null,
      notes: fw.rationale ?? null,
    };

    ctx.db.ensureSyntheticLegacyGroup(ctx.tickets as Array<TicketDef & Record<string, unknown>>);
    saveTickets(ctx.paths.tickets, [...ctx.tickets, newTicket]);
    try {
      ctx.db.transaction(() => {
        ctx.db.updateFutureWorkDisposition(futureWorkId, "accepted");
        logEvent(ctx.db, {
          timestamp: now,
          actor: opts.actor ?? null,
          ticketId: opts.ticketId,
          eventType: "accept-future-work",
          oldStatus: null,
          newStatus: "planned",
          summary: `Accepted future work ${futureWorkId} as ticket ${opts.ticketId}`,
        });
        ctx.db.createTicketGroup({ origin: "future-work", operationId: `future-work:${futureWorkId}`, members: [{ ticketId: newTicket.id, definition: newTicket, validatedAt: now }] });
      });
    } catch (error) {
      saveTickets(ctx.paths.tickets, ctx.tickets);
      throw error;
    }
    // Re-open context to pick up new ticket list
    const newCtx = openContext(projectDir);
    try {
      renderAfterUpdate(newCtx);
    } finally {
      newCtx.db.close();
    }
  });
}

// ── reorder ───────────────────────────────────────────────────────────────────

export function cmdReorder(
  projectDir: string,
  ticketId: string,
  opts: { afterTicketId?: string; order?: number; actor?: string },
): void {
  withContext(projectDir, (ctx) => {
    const ticket = ctx.tickets.find((t) => t.id === ticketId);
    if (!ticket) throw new Error(`Ticket ${ticketId} not found`);

    let newOrder: number;
    if (opts.order !== undefined) {
      newOrder = opts.order;
    } else if (opts.afterTicketId) {
      const afterTicket = ctx.tickets.find((t) => t.id === opts.afterTicketId);
      if (!afterTicket) throw new Error(`Ticket ${opts.afterTicketId} not found`);
      const sorted = [...ctx.tickets].sort((a, b) => a.order - b.order);
      const afterIdx = sorted.findIndex((t) => t.id === opts.afterTicketId);
      const next = sorted[afterIdx + 1];
      newOrder = next ? Math.floor((afterTicket.order + next.order) / 2) : afterTicket.order + 1000;
    } else {
      throw new Error("Provide --after <ticketId> or --order <n>");
    }

    const now = nowTimestamp(ctx.config.timezone);
    const updated = ctx.tickets.map((t) => t.id === ticketId ? { ...t, order: newOrder } : t);
    saveTickets(ctx.paths.tickets, updated);

    ctx.db.transaction(() => {
      logEvent(ctx.db, {
        timestamp: now,
        actor: opts.actor ?? null,
        ticketId,
        eventType: "reorder",
        oldStatus: null,
        newStatus: null,
        summary: `Reordered ticket ${ticketId} to order ${newOrder}`,
      });
    });

    // Re-open with updated tickets
    const newCtx = openContext(projectDir);
    try {
      renderAfterUpdate(newCtx);
    } finally {
      newCtx.db.close();
    }
  });
}

// ── render ────────────────────────────────────────────────────────────────────

export function cmdRender(projectDir: string): void {
  withContext(projectDir, (ctx) => {
    renderAfterUpdate(ctx);
  });
}

// ── validate ──────────────────────────────────────────────────────────────────

export interface ValidateResult {
  issues: ReturnType<typeof runAllValidation>;
  clean: boolean;
}

export function cmdValidate(projectDir: string): ValidateResult {
  return withContext(projectDir, (ctx) => {
    const states = ctx.db.getAllStates();
    const issues = runAllValidation(ctx.config, projectDir, ctx.tickets, states, ctx.db);
    return { issues, clean: issues.filter((i) => i.severity === "error").length === 0 };
  });
}

// ── queue ─────────────────────────────────────────────────────────────────────

export function cmdQueue(projectDir: string, limit?: number) {
  return withContext(projectDir, (ctx) => {
    const states = ctx.db.getAllStates();
    return buildNextQueue(ctx.tickets, states, limit ?? ctx.config.viewLimit);
  });
}

export function cmdStackQueue(projectDir: string, refresh = false): string[] {
  return withContext(projectDir, (ctx) => {
    let delivery = loadDeliveryConfig(projectDir);
    if (delivery && refresh) {
      const unitById = new Map(delivery.units.map((unit) => [unit.id, unit]));
      delivery = { ...delivery, stacks: (delivery.stacks ?? []).map((stack) => {
        const links = stack.review_links ?? [];
        const providers = new Set(stack.units.map((id) => unitById.get(id)?.provider).filter((value): value is "github" | "gitlab" => value === "github" || value === "gitlab"));
        if (!links.length || providers.size !== 1) return { ...stack, remote_stale: true };
        const provider = [...providers][0]!;
        const checks = links.map((link) => provider === "gitlab" ? checkGitLabMrMerged(projectDir, link) : checkGitHubPrMerged(projectDir, link));
        if (checks.some((check) => !check.ok)) return { ...stack, remote_stale: true };
        return {
          ...stack,
          status: checks.every((check) => check.ok && check.merged) ? "merged" as const : "awaiting_review" as const,
          review_links: checks.map((check, index) => check.ok ? (check.url ?? links[index]!) : links[index]!),
          remote_checked_at: new Date().toISOString(), remote_stale: false,
        };
      }) };
      saveDeliveryConfig(projectDir, delivery);
    }
    return formatStackAwareQueue(ctx.tickets, ctx.db.getAllStates(), delivery);
  });
}

export function cmdImplementationQueue(projectDir: string) {
  return withContext(projectDir, (ctx) => {
    const states = ctx.db.getAllStates();
    return buildNextQueue(ctx.tickets, states, ctx.config.implementationLimit);
  });
}

// ── archive ───────────────────────────────────────────────────────────────────

export function cmdArchive(projectDir: string, _opts: { olderThanDays?: number }): void {
  withContext(projectDir, (ctx) => {
    const now = nowTimestamp(ctx.config.timezone);
    logEvent(ctx.db, {
      timestamp: now,
      actor: "system",
      ticketId: null,
      eventType: "archive",
      oldStatus: null,
      newStatus: null,
      summary: "Archive pass executed",
    });
    renderAfterUpdate(ctx);
  });
}

// ── review recommendations ──────────────────────────────────────────────────

export function cmdReview(projectDir: string, opts: ReviewCommandOptions = {}): ReviewCommandResult {
  return cmdReviewRecommendations(projectDir, opts);
}
