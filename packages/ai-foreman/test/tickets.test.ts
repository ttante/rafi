import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse, stringify } from "yaml";

import { buildNextQueue, formatStackAwareQueue } from "../src/tickets/queue.js";
import { computeDisplayStatus, resolveBlockers } from "../src/tickets/blockers.js";
import { validateTicketDefs, detectCycles } from "../src/tickets/ticketLoader.js";
import {
  cmdInit,
  cmdUpdate,
  cmdComplete,
  cmdBlock,
  cmdQueue,
  cmdImplementationQueue,
  cmdDiscover,
  cmdAcceptFutureWork,
  cmdValidate,
  cmdRender,
} from "../src/tickets/commands.js";
import { Log } from "../src/log.js";
import {
  cmdPopulateCli,
  buildPopulateAgentRunOptions,
  buildPopulateInstruction,
  resolvePopulateSources,
} from "../src/cli/tickets.js";
import { loadTicketsConfig } from "../src/tickets/config.js";
import { applyImportedItems } from "../src/tickets/importer.js";
import { cmdReview } from "../src/tickets/commands.js";
import { createReviewRecommendation } from "../src/tickets/recommendations.js";
import { StateDb } from "../src/tickets/stateDb.js";
import {
  loadTicketSetupConfig,
  saveTicketSetupConfig,
  DEFAULT_TICKET_SETUP,
} from "../src/tickets/setupConfig.js";
import type { TicketDef } from "../src/tickets/ticketSchema.js";
import type { TicketState } from "../src/tickets/stateDb.js";
import { formatTicketDetails, getTicketDetails } from "../src/tickets/details.js";
import { previewTicketReset, resetTickets } from "../src/tickets/reset.js";
import { applyResolvedTicketReset, resolveTicketResetSelection, TicketResetDependencyConflictError } from "../src/tickets/groupReset.js";
import { listTicketGroups } from "../src/tickets/groups.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeDef(id: string, order: number, overrides: Partial<TicketDef> = {}): TicketDef {
  return {
    id,
    order,
    title: `Ticket ${id}`,
    area: "Platform",
    priority: "P1",
    size: "S",
    risk: "Low",
    depends_on: [],
    summary: `Summary for ${id}`,
    acceptance: ["It works"],
    required_tests: ["Unit test"],
    likely_files: ["src/*"],
    rollback: null,
    notes: null,
    ...overrides,
  };
}

function makeState(ticketId: string, status: TicketState["status"]): [string, TicketState] {
  return [ticketId, {
    ticket_id: ticketId,
    status,
    owner: null,
    current_step: null,
    next_action: null,
    blocked_by_json: "[]",
    blocker_type: null,
    blocker_notes: null,
    first_blocked_at: null,
    last_checked_at: null,
    last_worked_at: null,
    completed_at: null,
    attempt_count: 0,
    last_error: null,
    evidence: null,
    validation_result: null,
    validation_commands: null,
    validation_notes: null,
    updated_at: "2026-01-01T00:00:00Z",
    updated_by: null,
  }];
}

function makeDefs(count: number): TicketDef[] {
  return Array.from({ length: count }, (_, i) =>
    makeDef(`T${String(i + 1).padStart(3, "0")}`, (i + 1) * 1000),
  );
}

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "foreman-tickets-test-"));
}

function writeTrackerConfig(dir: string, config: Record<string, unknown>): void {
  mkdirSync(join(dir, ".tickets"), { recursive: true });
  writeFileSync(join(dir, ".tickets", "config.yaml"), stringify(config), "utf8");
}

test("ticket details retain unknown canonical fields and include complete state history", () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Details", timezone: "UTC" });
    const ticket = { ...makeDef("T123", 1000), custom_forward_field: { enabled: true } };
    writeFileSync(join(dir, ".tickets", "tickets.yaml"), stringify({ tickets: [ticket] }), "utf8");
    cmdUpdate(dir, "T123", { status: "in_progress", owner: "Rafi", evidence: "partial", validationResult: "not_run" });
    const db = new StateDb(join(dir, ".tickets", "ticket-state.sqlite"));
    db.insertValidationSnapshot({ timestamp: "2026-01-01T00:00:00.000Z", scope: "T123", result: "passed", commands: "pnpm test", evidence: "ok", notes: null });
    db.close();

    const details = getTicketDetails(dir, "T123", new Date("2026-01-02T00:00:00.000Z"));
    assert.deepEqual(details.definition.custom_forward_field, { enabled: true });
    assert.equal(details.state.owner, "Rafi");
    assert.equal(details.validation_history.length, 1);
    assert.equal(details.events.length, 1);
    const report = formatTicketDetails(details).join("\n");
    assert.match(report, /custom_forward_field/);
    assert.match(report, /Summary for T123/);
    assert.match(report, /Active validation and evidence/);
    assert.match(report, /History/);
    assert.throws(() => getTicketDetails(dir, "missing"), /rafi tickets queue/);
  } finally { rmSync(dir, { recursive: true }); }
});

test("ticket reset clears every active field but preserves dependencies and audit history", () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Reset", timezone: "UTC" });
    writeFileSync(join(dir, ".tickets", "tickets.yaml"), stringify({ tickets: [
      makeDef("T001", 1000),
      makeDef("T002", 2000, { depends_on: ["T001"] }),
      makeDef("T003", 3000),
    ] }), "utf8");
    const db = new StateDb(join(dir, ".tickets", "ticket-state.sqlite"));
    db.upsertState("T002", {
      status: "blocked", owner: "builder", current_step: "code", next_action: "test",
      blocked_by_json: JSON.stringify(["external"]), blocker_type: "external", blocker_notes: "waiting",
      first_blocked_at: "2026-01-01", last_checked_at: "2026-01-02", last_worked_at: "2026-01-02",
      completed_at: "2026-01-02", attempt_count: 4, last_error: "bad", evidence: "old",
      validation_result: "failed", validation_commands: "pnpm test", validation_notes: "failed", updated_by: "builder",
    }, "2026-01-02T00:00:00.000Z");
    db.insertValidationSnapshot({ timestamp: "2026-01-02T00:00:00.000Z", scope: "T002", result: "failed", commands: "pnpm test", evidence: "old", notes: "failed" });
    db.close();

    const preview = previewTicketReset(dir, "T002");
    assert.deepEqual(preview.tickets[0]?.cleared.sort(), ["active validation/evidence", "attempt count", "last error", "owner", "status", "steps", "temporary blockers", "work timestamps"].sort());
    const resetId = "00000000-0000-4000-8000-000000000001";
    const result = resetTickets(dir, "T002", "tester", new Date("2026-01-03T00:00:00.000Z"), { resetId });
    assert.deepEqual(result.tickets, ["T002"]);
    assert.deepEqual(resetTickets(dir, "T002", "tester", new Date("2026-01-03T00:00:01.000Z"), { resetId }), result);
    const details = getTicketDetails(dir, "T002");
    assert.equal(details.state.status, "planned");
    assert.equal(details.state.owner, null);
    assert.equal(details.state.attempt_count, 0);
    assert.equal(details.state.evidence, null);
    assert.deepEqual(details.definition.depends_on, ["T001"]);
    assert.deepEqual(details.effective_blockers, ["T001"]);
    assert.equal(details.validation_history.length, 1);
    assert.equal(details.events.at(-1)?.event_type, "ticket_reset");
    assert.equal(details.events.filter((event) => event.event_type === "ticket_reset").length, 1);
  } finally { rmSync(dir, { recursive: true }); }
});

test("ticket reset publication failure restores state, audit events, recent-completed context, and rendered output", () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Reset rollback", timezone: "UTC" });
    writeFileSync(join(dir, ".tickets", "tickets.yaml"), stringify({ tickets: [makeDef("T001", 1000)] }), "utf8");
    const db = new StateDb(join(dir, ".tickets", "ticket-state.sqlite"));
    db.upsertState("T001", { status: "done", owner: "builder", evidence: "original evidence" }, "2026-01-01T00:00:00.000Z");
    db.upsertRecentCompleted({ ticket_id: "T001", why_it_remains_here: "recent", pinned_until: null, updated_at: "2026-01-01T00:00:00.000Z" });
    db.close();
    cmdRender(dir);
    const progressPath = join(dir, "docs", "ticket-progress.md");
    const progressBefore = readFileSync(progressPath, "utf8");

    assert.throws(
      () => resetTickets(dir, "T001", "tester", new Date("2026-01-03T00:00:00.000Z"), { beforePublish: () => { throw new Error("injected publication failure"); } }),
      /injected publication failure/,
    );

    const rolledBack = new StateDb(join(dir, ".tickets", "ticket-state.sqlite"));
    assert.equal(rolledBack.getState("T001")?.status, "done");
    assert.equal(rolledBack.getState("T001")?.owner, "builder");
    assert.equal(rolledBack.getState("T001")?.evidence, "original evidence");
    assert.equal(rolledBack.getTicketEvents("T001").some((event) => event.event_type === "ticket_reset"), false);
    assert.deepEqual(rolledBack.getRecentCompleted().map((row) => row.ticket_id), ["T001"]);
    rolledBack.close();
    assert.equal(readFileSync(progressPath, "utf8"), progressBefore);
  } finally { rmSync(dir, { recursive: true }); }
});

test("group reset freezes its preview and restores deleted dependencies without resetting them", () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Group reset", timezone: "UTC" });
    const dependency = makeDef("T001", 1000);
    const dependent = makeDef("T002", 2000, { depends_on: ["T001"] });
    const unrelated = makeDef("T003", 3000);
    writeFileSync(join(dir, ".tickets", "tickets.yaml"), stringify({ tickets: [dependency, dependent, unrelated] }), "utf8");
    const db = new StateDb(join(dir, ".tickets", "ticket-state.sqlite"));
    db.upsertState("T001", { status: "done", evidence: "dependency evidence" }, "2026-01-01T00:00:00.000Z");
    db.upsertState("T002", { status: "blocked", owner: "builder" }, "2026-01-01T00:00:00.000Z");
    db.upsertState("T003", { status: "in_progress" }, "2026-01-01T00:00:00.000Z");
    db.createTicketGroup({ origin: "ticket-plan", operationId: "group-dependency", members: [{ ticketId: "T001", definition: dependency }] });
    db.createTicketGroup({ origin: "ticket-plan", operationId: "group-dependent", members: [{ ticketId: "T002", definition: dependent }] });
    db.createTicketGroup({ origin: "ticket-plan", operationId: "group-unrelated", members: [{ ticketId: "T003", definition: unrelated }] });
    db.close();

    // Simulate manual deletion while retaining the last Rafi-validated snapshots.
    writeFileSync(join(dir, ".tickets", "tickets.yaml"), stringify({ tickets: [unrelated] }), "utf8");
    assert.throws(
      () => resolveTicketResetSelection(dir, { kind: "group", groupId: "TG-2" }, { deletedTickets: "restore" }),
      (error) => error instanceof TicketResetDependencyConflictError && error.conflicts[0]?.dependencyId === "T001",
    );
    const selection = resolveTicketResetSelection(dir, { kind: "group", groupId: "TG-2" }, { deletedTickets: "restore", restoreDependencies: ["T001"] });
    assert.deepEqual(selection.ticketIds, ["T002"]);
    assert.deepEqual(selection.definitionRestorations.map((item) => [item.ticketId, Boolean(item.dependencyOnly)]), [["T002", false], ["T001", true]]);
    const applied = applyResolvedTicketReset(dir, selection, "tester", new Date("2026-01-02T00:00:00.000Z"));
    assert.deepEqual(applied.tickets, ["T002"]);
    assert.deepEqual(applied.restored, ["T002", "T001"]);
    const restored = new StateDb(join(dir, ".tickets", "ticket-state.sqlite"));
    assert.equal(restored.getState("T002")?.status, "planned");
    assert.equal(restored.getState("T001")?.status, "done", "dependency-only restoration must not reset the dependency");
    restored.close();
    const listed = listTicketGroups(dir);
    assert.deepEqual(listed.groups.map((group) => [group.id, group.recencyPosition]), [["TG-3", 1], ["TG-2", 2], ["TG-1", 3]]);

    const frozenBeforeNewGroup = resolveTicketResetSelection(dir, { kind: "group", groupId: "TG-3" });
    const currentDefinitions = (parse(readFileSync(join(dir, ".tickets", "tickets.yaml"), "utf8")) as { tickets: TicketDef[] }).tickets;
    const addedAfterPreview = makeDef("T004", 4000);
    writeFileSync(join(dir, ".tickets", "tickets.yaml"), stringify({ tickets: [...currentDefinitions, addedAfterPreview] }), "utf8");
    const changedCatalogDb = new StateDb(join(dir, ".tickets", "ticket-state.sqlite"));
    changedCatalogDb.createTicketGroup({ origin: "production", operationId: "new-group-after-preview", members: [{ ticketId: "T004", definition: addedAfterPreview }] });
    changedCatalogDb.close();
    assert.throws(() => applyResolvedTicketReset(dir, frozenBeforeNewGroup), /inputs changed after preview/);

    const frozen = resolveTicketResetSelection(dir, { kind: "group", groupId: "TG-3" });
    cmdUpdate(dir, "T003", { status: "blocked", summary: "changed after preview" });
    assert.throws(() => applyResolvedTicketReset(dir, frozen), /inputs changed after preview/);
  } finally { rmSync(dir, { recursive: true }); }
});

test("bulk reset scopes match the agreed terminal-state rules", () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Scopes", timezone: "UTC" });
    const defs = ["planned", "next", "in_progress", "blocked", "done", "canceled", "obsolete"].map((status, index) => makeDef(`T00${index + 1}`, (index + 1) * 1000, { title: status }));
    writeFileSync(join(dir, ".tickets", "tickets.yaml"), stringify({ tickets: defs }), "utf8");
    const db = new StateDb(join(dir, ".tickets", "ticket-state.sqlite"));
    defs.forEach((ticket, index) => db.upsertState(ticket.id, { status: ["planned", "next", "in_progress", "blocked", "done", "canceled", "obsolete"][index] as TicketState["status"] }, "2026-01-01T00:00:00.000Z"));
    db.close();
    assert.equal(previewTicketReset(dir, "all").tickets.length, 7);
    assert.deepEqual(previewTicketReset(dir, "completed-and-unfinished").tickets.map((row) => row.status), ["planned", "next", "in_progress", "blocked", "done"]);
    assert.deepEqual(previewTicketReset(dir, "unfinished").tickets.map((row) => row.status), ["planned", "next", "in_progress", "blocked"]);
  } finally { rmSync(dir, { recursive: true }); }
});

// ── populate instruction ─────────────────────────────────────────────────────

test("populate instruction includes optional source hints and scan guidance", () => {
  const instruction = buildPopulateInstruction(["docs/tickets.md", "docs/plans/**"]);

  assert.match(instruction, /User-provided planning source hints/);
  assert.match(instruction, /- docs\/tickets\.md/);
  assert.match(instruction, /- docs\/plans\/\*\*/);
  assert.match(instruction, /files, folders, or globs/);
  assert.match(instruction, /Any reasonable project-planning format is acceptable/);
  assert.match(instruction, /Then inspect the repository for existing planning sources/);
});

test("populate instruction uses the configured progress doc path", () => {
  const instruction = buildPopulateInstruction(undefined, "docs-rafi/ticket-progress.md");
  assert.match(instruction, /docs-rafi\/ticket-progress\.md if it exists/);
  assert.doesNotMatch(instruction, /docs\/ticket-progress\.md if it exists/);
});

test("populate instruction says to scan when no source hints are provided", () => {
  const instruction = buildPopulateInstruction();

  assert.match(instruction, /No specific planning sources were provided/);
  assert.match(instruction, /Scan the repository for relevant planning and ticketing documents/);
});

test("populate defaults to the latest Rafi plan when present", () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC", docsRoot: "docs-rafi" });
    writeFileSync(join(dir, "docs-rafi", "rafi-plan.md"), "# Plan\n", "utf8");

    const sources = resolvePopulateSources(dir, undefined, loadTicketsConfig(dir));

    assert.deepEqual(sources, ["docs-rafi/rafi-plan.md"]);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("populate prefers Rafi config docs root over ticket progress docs root", () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, "rafi-config.yaml"), stringify({ docs: { root: "docs-rafi" } }), "utf8");
    cmdInit(dir, { appName: "Test", timezone: "UTC", docsRoot: "custom-docs" });
    mkdirSync(join(dir, "docs-rafi"), { recursive: true });
    writeFileSync(join(dir, "docs-rafi", "rafi-plan.md"), "# Rafi Plan\n", "utf8");
    writeFileSync(join(dir, "project.yaml"), stringify({ docs: { root: "../outside" } }), "utf8");

    const sources = resolvePopulateSources(dir, undefined, loadTicketsConfig(dir));

    assert.deepEqual(sources, ["docs-rafi/rafi-plan.md"]);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("populate falls back from legacy Rafi docs root to ticket docs root, docs root, then scanning", () => {
  const legacyOnly = makeTmpDir();
  const ticketDocs = makeTmpDir();
  const defaultDocs = makeTmpDir();
  const none = makeTmpDir();
  try {
    writeFileSync(join(legacyOnly, "project.yaml"), stringify({ docs: { root: "legacy-docs" } }), "utf8");
    cmdInit(legacyOnly, { appName: "Test", timezone: "UTC", docsRoot: "custom-docs" });
    mkdirSync(join(legacyOnly, "legacy-docs"), { recursive: true });
    writeFileSync(join(legacyOnly, "legacy-docs", "rafi-plan.md"), "# Legacy Plan\n", "utf8");
    assert.deepEqual(resolvePopulateSources(legacyOnly, undefined, loadTicketsConfig(legacyOnly)), ["legacy-docs/rafi-plan.md"]);

    cmdInit(ticketDocs, { appName: "Test", timezone: "UTC", docsRoot: "custom-docs" });
    writeFileSync(join(ticketDocs, "custom-docs", "rafi-plan.md"), "# Ticket Plan\n", "utf8");
    assert.deepEqual(resolvePopulateSources(ticketDocs, undefined, loadTicketsConfig(ticketDocs)), ["custom-docs/rafi-plan.md"]);

    cmdInit(defaultDocs, { appName: "Test", timezone: "UTC", docsRoot: "custom-docs" });
    mkdirSync(join(defaultDocs, "docs"), { recursive: true });
    writeFileSync(join(defaultDocs, "docs", "rafi-plan.md"), "# Default Plan\n", "utf8");
    assert.deepEqual(resolvePopulateSources(defaultDocs, undefined, loadTicketsConfig(defaultDocs)), ["docs/rafi-plan.md"]);

    cmdInit(none, { appName: "Test", timezone: "UTC", docsRoot: "custom-docs" });
    assert.equal(resolvePopulateSources(none, undefined, loadTicketsConfig(none)), undefined);
  } finally {
    rmSync(legacyOnly, { recursive: true });
    rmSync(ticketDocs, { recursive: true });
    rmSync(defaultDocs, { recursive: true });
    rmSync(none, { recursive: true });
  }
});

test("populate errors on invalid active Rafi config docs root", () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC", docsRoot: "custom-docs" });
    writeFileSync(join(dir, "rafi-config.yaml"), stringify({ docs: { root: "../outside" } }), "utf8");

    assert.throws(
      () => resolvePopulateSources(dir, undefined, loadTicketsConfig(dir)),
      /docs root must not contain parent-directory traversal/,
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("populate explicit sources bypass invalid config parsing", () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC", docsRoot: "custom-docs" });
    writeFileSync(join(dir, "rafi-config.yaml"), stringify({ docs: { root: "../outside" } }), "utf8");

    const sources = resolvePopulateSources(dir, ["docs/custom.md"], loadTicketsConfig(dir));

    assert.deepEqual(sources, ["docs/custom.md"]);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("populate explicit sources override the latest Rafi plan default", () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC", docsRoot: "docs-rafi" });
    writeFileSync(join(dir, "docs-rafi", "rafi-plan.md"), "# Plan\n", "utf8");

    const sources = resolvePopulateSources(dir, ["docs/custom.md"], loadTicketsConfig(dir));

    assert.deepEqual(sources, ["docs/custom.md"]);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("ticket setup config round-trips through rafi-config.yaml", () => {
  const dir = makeTmpDir();
  try {
    saveTicketSetupConfig(dir, {
      ...DEFAULT_TICKET_SETUP,
      sources: [{ type: "local", paths: ["docs/plan.md"] }],
      limits: { implementation: 321, view: 12_345 },
      build: {
        ...DEFAULT_TICKET_SETUP.build, completion: "auto-merge", provider: "github", pr_ready: true, base_branch: "trunk",
        branch_policy: { mode: "size", global_strategy: "batch", by_size: { XS: "shared", S: "per-ticket", M: "shared", L: "per-ticket", XL: "per-ticket" } },
        review: { title_style: "custom", title_template: "[{id}] {title}", description_sections: ["Summary", "Security review"] },
        validation_checklist: ["custom check", "evidence attached"],
      },
    }, { appName: "Config Test", docsRoot: "docs-rafi", targets: ["codex"] });

    const raw = parse(readFileSync(join(dir, "rafi-config.yaml"), "utf8")) as Record<string, unknown>;
    const loaded = loadTicketSetupConfig(dir);

    assert.equal(raw.appName, "Config Test");
    assert.deepEqual((raw.harness as Record<string, unknown>).targets, ["codex"]);
    assert.deepEqual(loaded?.sources, [{ type: "local", paths: ["docs/plan.md"] }]);
    assert.equal(loaded?.build.completion, "auto-merge");
    assert.equal(loaded?.populate.import_cap, 500);
    assert.deepEqual(loaded?.limits, { implementation: 321, view: 12_345 });
    assert.equal(loaded?.build.base_branch, "trunk");
    assert.deepEqual(loaded?.build.branch_policy.by_size, { XS: "shared", S: "per-ticket", M: "shared", L: "per-ticket", XL: "per-ticket" });
    assert.deepEqual(loaded?.build.review, { title_style: "custom", title_template: "[{id}] {title}", description_sections: ["Summary", "Security review"] });
    assert.deepEqual(loaded?.build.validation_checklist, ["custom check", "evidence attached"]);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("populate uses saved local setup sources before rafi-plan fallback", () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC", docsRoot: "docs-rafi" });
    writeFileSync(join(dir, "docs-rafi", "rafi-plan.md"), "# Plan\n", "utf8");
    saveTicketSetupConfig(dir, {
      ...DEFAULT_TICKET_SETUP,
      sources: [{ type: "local", paths: ["docs/backlog.md"] }],
    });

    const sources = resolvePopulateSources(dir, undefined, loadTicketsConfig(dir));

    assert.deepEqual(sources, ["docs/backlog.md"]);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("populate imports saved external-only setup without requiring a local source", async () => {
  const dir = makeTmpDir();
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.LINEAR_API_KEY;
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC" });
    saveTicketSetupConfig(dir, {
      ...DEFAULT_TICKET_SETUP,
      sources: [{ type: "linear", api_key_env: "LINEAR_API_KEY", team_key: "ENG", filter: null }],
    });
    process.env.LINEAR_API_KEY = "test-key";
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: {
        issues: {
          nodes: [{
            id: "lin-1",
            identifier: "ENG-1",
            title: "External import only",
            description: "Imported without a local source prompt",
            priority: 2,
            estimate: 2,
            url: "https://linear.app/acme/issue/ENG-1/external-import-only",
            state: { name: "Todo", type: "backlog" },
            team: { key: "ENG", name: "Engineering" },
            labels: { nodes: [] },
            comments: { nodes: [] },
          }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    }), { status: 200 })) as typeof fetch;

    await cmdPopulateCli({ project: dir, yes: true });

    const raw = parse(readFileSync(join(dir, ".tickets/tickets.yaml"), "utf8")) as { tickets: TicketDef[] };
    assert.equal(raw.tickets.length, 1);
    assert.equal(raw.tickets[0]?.id, "T001");
    assert.equal(raw.tickets[0]?.external_refs?.[0]?.provider, "linear");
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = oldKey;
    rmSync(dir, { recursive: true });
  }
});

test("external import creates stable tickets and updates repeat imports by external ref", () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC" });

    let applied = applyImportedItems(dir, [{
      provider: "linear",
      providerId: "lin-1",
      key: "ENG-1",
      url: "https://linear.app/acme/issue/ENG-1/test",
      title: "Build importer",
      description: "Importer details",
      priority: 2,
      size: 8,
      status: "Todo",
      statusCategory: "backlog",
      labels: ["platform"],
      comments: [{ author: "A", body: "First comment" }],
      raw: { id: "lin-1" },
    }]);

    assert.equal(applied.created, 1);
    assert.equal(applied.updated, 0);
    assert.equal(applied.tickets[0].id, "T001");
    assert.equal(applied.tickets[0].external_refs?.[0]?.provider, "linear");
    assert.equal(applied.tickets[0].size, "XL");

    applied = applyImportedItems(dir, [{
      provider: "linear",
      providerId: "lin-1",
      key: "ENG-1",
      url: "https://linear.app/acme/issue/ENG-1/test",
      title: "Build importer v2",
      description: "Importer details v2",
      priority: 3,
      size: 3,
      status: "Done",
      statusCategory: "completed",
      labels: [],
      comments: [],
      raw: { id: "lin-1" },
    }]);

    assert.equal(applied.created, 0);
    assert.equal(applied.updated, 1);
    assert.equal(applied.tickets.length, 1);
    assert.equal(applied.tickets[0].id, "T001");
    assert.match(applied.tickets[0].title, /Build importer v2/);
    const db = new StateDb(join(dir, ".tickets/ticket-state.sqlite"));
    try {
      const groups = db.listTicketGroups();
      assert.equal(groups.length, 1);
      assert.equal(groups[0]?.origin, "import");
      assert.deepEqual(groups[0]?.members.map((member) => member.ticketId), ["T001"]);
      assert.match((groups[0]?.members[0]?.snapshot.definition as TicketDef).title, /Build importer v2/);
    } finally { db.close(); }
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("review accept applies deterministic ticket patch and rerenders", () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC" });
    writeFileSync(join(dir, ".tickets/tickets.yaml"), stringify({ tickets: [makeDef("T001", 1000, { size: "XL" })] }));
    const db = new StateDb(join(dir, ".tickets/ticket-state.sqlite"));
    try {
      createReviewRecommendation(db, "2026-01-01T00:00:00Z", {
        kind: "split",
        summary: "Split T001",
        ticketIds: ["T001"],
        patch: {
          update: [{ id: "T001", set: { size: "L", notes: "Accepted split review." } }],
          add: [makeDef("T002", 2000, { title: "Split follow-up" })],
        },
      });
    } finally {
      db.close();
    }

    const listed = cmdReview(dir);
    assert.equal(listed.pending.length, 1);
    const result = cmdReview(dir, { action: "accept", ids: [listed.pending[0].id!] });
    const raw = parse(readFileSync(join(dir, ".tickets/tickets.yaml"), "utf8")) as { tickets: TicketDef[] };
    const doc = readFileSync(join(dir, "docs/ticket-progress.md"), "utf8");

    assert.equal(result.changed, 1);
    assert.equal(raw.tickets[0].size, "L");
    assert.equal(raw.tickets[1]?.id, "T002");
    assert.match(doc, /No pending review recommendations/);
    const groupDb = new StateDb(join(dir, ".tickets/ticket-state.sqlite"));
    try {
      assert.deepEqual(groupDb.listTicketGroups().map((group) => [group.origin, group.members.map((member) => member.ticketId)]), [
        ["production", ["T002"]],
        ["legacy", ["T001"]],
      ]);
    } finally { groupDb.close(); }
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("populate agent run options use the ticket-maker role", () => {
  const dir = makeTmpDir();
  try {
    const log = new Log(join(dir, ".foreman", "test.jsonl"));
    const opts = buildPopulateAgentRunOptions({
      projectDir: dir,
      agent: "codex",
      log,
    });

    assert.equal(opts.role, "ticket-maker");
    assert.equal(opts.label, "tickets populate");
    assert.equal(opts.agent, "codex");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── queue computation ─────────────────────────────────────────────────────────

test("buildNextQueue: empty tickets yields empty queue", () => {
  const rows = buildNextQueue([], new Map(), 50);
  assert.equal(rows.length, 0);
});

test("buildNextQueue: returns up to queueLimit rows", () => {
  const defs = Array.from({ length: 60 }, (_, i) => makeDef(`T${String(i + 1).padStart(3, "0")}`, (i + 1) * 1000));
  const rows = buildNextQueue(defs, new Map(), 50);
  assert.equal(rows.length, 50);
  assert.equal(rows[0].ticket, "T001");
  assert.equal(rows[49].ticket, "T050");
});

test("buildNextQueue: returns all tickets when fewer than limit", () => {
  const defs = [makeDef("T001", 1000), makeDef("T002", 2000)];
  const rows = buildNextQueue(defs, new Map(), 50);
  assert.equal(rows.length, 2);
});

test("buildNextQueue: done ticket leaves queue and T051 enters when 55 tickets exist", () => {
  const defs = Array.from({ length: 55 }, (_, i) => makeDef(`T${String(i + 1).padStart(3, "0")}`, (i + 1) * 1000));
  const states = new Map([makeState("T001", "done")]);

  const rows = buildNextQueue(defs, states, 50);
  assert.equal(rows.length, 50);
  assert.equal(rows[0].ticket, "T002");
  assert.ok(rows.some((r) => r.ticket === "T051"), "T051 should enter the queue");
  assert.ok(!rows.some((r) => r.ticket === "T001"), "T001 should not be in queue");
});

test("buildNextQueue: ranks are contiguous starting at 1", () => {
  const defs = Array.from({ length: 5 }, (_, i) => makeDef(`T00${i + 1}`, (i + 1) * 1000));
  const rows = buildNextQueue(defs, new Map(), 50);
  rows.forEach((r, i) => assert.equal(r.rank, i + 1));
});

test("formatStackAwareQueue: flat queue states that no batches are configured", () => {
  const lines = formatStackAwareQueue([makeDef("T001", 1000)], new Map());
  assert.equal(lines[0], "Batches: none configured. Queue is flat.");
  assert.match(lines.join("\n"), /T001 next Ticket T001/);
});

test("formatStackAwareQueue: delivery stacks are labeled as batches with PR-chain wording", () => {
  const defs = [makeDef("T001", 1000), makeDef("T002", 2000)];
  const lines = formatStackAwareQueue(defs, new Map(), {
    version: 1,
    units: [
      { id: "u1", tickets: ["T001"], branch_mode: "per-ticket", dependency_mode: "stack" },
      { id: "u2", tickets: ["T002"], branch_mode: "per-ticket", dependency_mode: "stack", depends_on: ["u1"] },
    ],
    stacks: [{ id: "s1", name: "Checkout", units: ["u1", "u2"] }],
  });
  const output = lines.join("\n");
  assert.match(output, /Batches: 1 configured/);
  assert.match(output, /=== Batch 1: Checkout \(s1\) ===/);
  assert.match(output, /delivery=PR chain/);
  assert.doesNotMatch(output, /STACK START/);
});

test("buildNextQueue: sorted by order not by ID", () => {
  const defs = [makeDef("T003", 1000), makeDef("T001", 3000), makeDef("T002", 2000)];
  const rows = buildNextQueue(defs, new Map(), 50);
  assert.equal(rows[0].ticket, "T003");
  assert.equal(rows[1].ticket, "T002");
  assert.equal(rows[2].ticket, "T001");
});

test("buildNextQueue: canceled ticket excluded like done", () => {
  const defs = [makeDef("T001", 1000), makeDef("T002", 2000)];
  const states = new Map([makeState("T001", "canceled")]);
  const rows = buildNextQueue(defs, states, 50);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ticket, "T002");
});

// ── display status ────────────────────────────────────────────────────────────

test("computeDisplayStatus: in_progress takes precedence over blockers", () => {
  assert.equal(computeDisplayStatus("in_progress", ["T000"]), "in_progress");
});

test("computeDisplayStatus: blocked when blockedBy non-empty", () => {
  assert.equal(computeDisplayStatus("planned", ["T000"]), "blocked");
});

test("computeDisplayStatus: next when planned and no blockers", () => {
  assert.equal(computeDisplayStatus("planned", []), "next");
});

test("computeDisplayStatus: done and canceled pass through", () => {
  assert.equal(computeDisplayStatus("done", []), "done");
  assert.equal(computeDisplayStatus("canceled", []), "canceled");
});

// ── blocker resolution ────────────────────────────────────────────────────────

test("resolveBlockers: unfinished dependency is a blocker", () => {
  const ticket = makeDef("T002", 2000, { depends_on: ["T001"] });
  const states = new Map([makeState("T001", "in_progress")]);
  const blockers = resolveBlockers(ticket, states);
  assert.deepEqual(blockers, ["T001"]);
});

test("resolveBlockers: done dependency is not a blocker", () => {
  const ticket = makeDef("T002", 2000, { depends_on: ["T001"] });
  const states = new Map([makeState("T001", "done")]);
  assert.deepEqual(resolveBlockers(ticket, states), []);
});

test("resolveBlockers: explicit SQLite blocker is included", () => {
  const ticket = makeDef("T003", 3000);
  const state: TicketState = {
    ...makeState("T003", "blocked")[1],
    blocked_by_json: '["external-api"]',
  };
  const blockers = resolveBlockers(ticket, new Map([["T003", state]]));
  assert.deepEqual(blockers, ["external-api"]);
});

// ── validation ────────────────────────────────────────────────────────────────

test("validateTicketDefs: duplicate IDs are caught", () => {
  const defs = [makeDef("T001", 1000), makeDef("T001", 2000)];
  const errors = validateTicketDefs(defs);
  assert.ok(errors.some((e) => e.message.includes("duplicate ticket ID")));
});

test("validateTicketDefs: duplicate order values are caught", () => {
  const defs = [makeDef("T001", 1000), makeDef("T002", 1000)];
  const errors = validateTicketDefs(defs);
  assert.ok(errors.some((e) => e.message.includes("duplicate order")));
});

test("validateTicketDefs: unknown dependency is caught", () => {
  const defs = [makeDef("T001", 1000, { depends_on: ["T999"] })];
  const errors = validateTicketDefs(defs);
  assert.ok(errors.some((e) => e.message.includes("references unknown ticket")));
});

test("validateTicketDefs: Medium risk without rollback is caught", () => {
  const defs = [makeDef("T001", 1000, { risk: "Medium", rollback: null })];
  const errors = validateTicketDefs(defs);
  assert.ok(errors.some((e) => e.message.includes("requires rollback")));
});

test("detectCycles: linear dependency chain has no cycle", () => {
  const defs = [
    makeDef("T001", 1000),
    makeDef("T002", 2000, { depends_on: ["T001"] }),
    makeDef("T003", 3000, { depends_on: ["T002"] }),
  ];
  assert.deepEqual(detectCycles(defs), []);
});

test("detectCycles: direct cycle is detected", () => {
  const defs = [
    makeDef("T001", 1000, { depends_on: ["T002"] }),
    makeDef("T002", 2000, { depends_on: ["T001"] }),
  ];
  const cycles = detectCycles(defs);
  assert.ok(cycles.length > 0, "should detect a cycle");
});

// ── integration: init + update + complete ─────────────────────────────────────

test("init creates expected files", () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC" });
    assert.ok(existsSync(join(dir, ".tickets/config.yaml")));
    assert.ok(existsSync(join(dir, ".tickets/tickets.yaml")));
    assert.ok(existsSync(join(dir, ".tickets/tracker-rules.md")));
    assert.ok(existsSync(join(dir, ".tickets/ticket-state.sqlite")));
    assert.ok(existsSync(join(dir, "docs/ticket-progress.md")));
    const rawConfig = parse(readFileSync(join(dir, ".tickets/config.yaml"), "utf8")) as Record<string, unknown>;
    assert.equal(rawConfig.implementation_limit, 500);
    assert.equal(rawConfig.view_limit, 20_000);
    assert.equal(rawConfig.queue_limit, undefined);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("config loads implementation and view limits", () => {
  const dir = makeTmpDir();
  try {
    writeTrackerConfig(dir, {
      app_name: "Test",
      implementation_limit: 123,
      view_limit: 456,
      timezone: "UTC",
    });

    const config = loadTicketsConfig(dir);

    assert.equal(config.implementationLimit, 123);
    assert.equal(config.viewLimit, 456);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("config upgrades legacy queue_limit 50 to default implementation limit", () => {
  const dir = makeTmpDir();
  try {
    writeTrackerConfig(dir, {
      app_name: "Test",
      ["queue_limit"]: 50,
      timezone: "UTC",
    });

    const config = loadTicketsConfig(dir);

    assert.equal(config.implementationLimit, 500);
    assert.equal(config.viewLimit, 20_000);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("config preserves non-50 legacy queue_limit as implementation limit", () => {
  const dir = makeTmpDir();
  try {
    writeTrackerConfig(dir, {
      app_name: "Test",
      queue_limit: 75,
      timezone: "UTC",
    });

    const config = loadTicketsConfig(dir);

    assert.equal(config.implementationLimit, 75);
    assert.equal(config.viewLimit, 20_000);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("config lets implementation_limit override legacy queue_limit", () => {
  const dir = makeTmpDir();
  try {
    writeTrackerConfig(dir, {
      app_name: "Test",
      queue_limit: 75,
      implementation_limit: 125,
      view_limit: 250,
      timezone: "UTC",
    });

    const config = loadTicketsConfig(dir);

    assert.equal(config.implementationLimit, 125);
    assert.equal(config.viewLimit, 250);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("init writes tracker docs under an explicit docs root", () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC", docsRoot: "docs-rafi" });
    const config = loadTicketsConfig(dir);
    assert.equal(config.paths.progressDoc, "docs-rafi/ticket-progress.md");
    assert.equal(config.paths.archiveDoc, "docs-rafi/ticket-archive.md");
    assert.ok(existsSync(join(dir, "docs-rafi/ticket-progress.md")));
    assert.ok(!existsSync(join(dir, "docs/ticket-progress.md")));
    assert.match(readFileSync(join(dir, ".tickets", "tracker-rules.md"), "utf8"), /docs-rafi\/ticket-progress\.md/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("init reads docs root from rafi-config.yaml when --docs-root is omitted", () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, "rafi-config.yaml"), stringify({ docs: { root: "docs-rafi" } }), "utf8");
    cmdInit(dir, { appName: "Test", timezone: "UTC" });
    assert.ok(existsSync(join(dir, "docs-rafi/ticket-progress.md")));
    assert.equal(loadTicketsConfig(dir).paths.progressDoc, "docs-rafi/ticket-progress.md");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("init --docs-root overrides rafi-config.yaml docs root", () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, "rafi-config.yaml"), stringify({ docs: { root: "docs-rafi" } }), "utf8");
    cmdInit(dir, { appName: "Test", timezone: "UTC", docsRoot: "custom-docs" });
    assert.ok(existsSync(join(dir, "custom-docs/ticket-progress.md")));
    assert.equal(loadTicketsConfig(dir).paths.progressDoc, "custom-docs/ticket-progress.md");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("init refuses to overwrite an existing selected progress doc", () => {
  const dir = makeTmpDir();
  try {
    mkdirSync(join(dir, "docs-rafi"), { recursive: true });
    writeFileSync(join(dir, "docs-rafi", "ticket-progress.md"), "# existing\n", "utf8");
    assert.throws(
      () => cmdInit(dir, { docsRoot: "docs-rafi" }),
      /docs-rafi\/ticket-progress\.md already exists/,
    );
    assert.ok(!existsSync(join(dir, ".tickets", "config.yaml")));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("init rejects docs roots that escape through symlinks", () => {
  const dir = makeTmpDir();
  const outside = makeTmpDir();
  try {
    symlinkSync(outside, join(dir, "outside-link"));
    assert.throws(
      () => cmdInit(dir, { docsRoot: "outside-link" }),
      /docs root must stay inside the repository/,
    );
    assert.throws(
      () => cmdInit(dir, { docsRoot: "outside-link/nested" }),
      /docs root must stay inside the repository/,
    );
    assert.ok(!existsSync(join(dir, ".tickets", "config.yaml")));
  } finally {
    rmSync(dir, { recursive: true });
    rmSync(outside, { recursive: true });
  }
});

test("validate passes against an alternate progress doc path", () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC", docsRoot: "docs-rafi" });
    const result = cmdValidate(dir);
    assert.equal(result.clean, true);
    assert.equal(result.issues.length, 0);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("update changes ticket status and regenerates progress doc", () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC" });
    writeFileSync(join(dir, ".tickets/tickets.yaml"), stringify({ tickets: [makeDef("T001", 1000)] }));

    cmdUpdate(dir, "T001", { status: "in_progress", actor: "test", summary: "started" });

    const doc = readFileSync(join(dir, "docs/ticket-progress.md"), "utf8");
    assert.ok(doc.includes("in_progress"), "progress doc should show in_progress");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("complete marks ticket done and removes it from queue", () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC" });
    writeFileSync(join(dir, ".tickets/tickets.yaml"),
      stringify({ tickets: [makeDef("T001", 1000), makeDef("T002", 2000)] }));

    cmdComplete(dir, "T001", {
      actor: "test",
      summary: "done",
      validationResult: "passed",
      evidence: "tests pass",
    });

    const rows = cmdQueue(dir);
    assert.ok(!rows.some((r) => r.ticket === "T001"), "T001 should be out of queue");
    assert.ok(rows.some((r) => r.ticket === "T002"), "T002 should remain");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("block makes ticket show as blocked with reason", () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC" });
    writeFileSync(join(dir, ".tickets/tickets.yaml"), stringify({ tickets: [makeDef("T001", 1000)] }));

    cmdBlock(dir, "T001", { blockedBy: ["external-api"], summary: "waiting on API" });

    const rows = cmdQueue(dir);
    assert.equal(rows[0].status, "blocked");
    assert.ok(rows[0].blockedBy.includes("external-api"));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("discover adds to future work inbox and appears in progress doc", () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC" });
    const id = cmdDiscover(dir, { summary: "Add metrics endpoint", rationale: "Needed for monitoring" });
    assert.ok(id > 0);

    const doc = readFileSync(join(dir, "docs/ticket-progress.md"), "utf8");
    assert.ok(doc.includes("Add metrics endpoint"));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("accepted future work publishes a singleton immutable creation group", () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC" });
    const futureWorkId = cmdDiscover(dir, { summary: "Add metrics endpoint", rationale: "Needed for monitoring" });
    cmdAcceptFutureWork(dir, futureWorkId, { ticketId: "T001", order: 1000, actor: "test" });
    const db = new StateDb(join(dir, ".tickets/ticket-state.sqlite"));
    try {
      const groups = db.listTicketGroups();
      assert.equal(groups.length, 1);
      assert.equal(groups[0]?.origin, "future-work");
      assert.deepEqual(groups[0]?.members.map((member) => member.ticketId), ["T001"]);
      assert.equal(db.getState("T001")?.status, "planned");
      assert.equal(db.getFutureWorkById(futureWorkId)?.disposition, "accepted");
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true }); }
});

test("generated progress doc uses the implementation limit", () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC" });
    writeFileSync(join(dir, ".tickets/tickets.yaml"), stringify({ tickets: makeDefs(505) }));

    cmdRender(dir);

    const doc = readFileSync(join(dir, "docs/ticket-progress.md"), "utf8");
    const queueBlock = doc.match(/<!-- LLM_NEXT_QUEUE_START -->\n([\s\S]*?)\n<!-- LLM_NEXT_QUEUE_END -->/)?.[1] ?? "";
    const queueRows = queueBlock.split("\n").filter((line) => /^\| \d+ \|/.test(line));
    assert.equal(queueRows.length, 500);
    assert.match(queueBlock, /\| 500 \| T500 \|/);
    assert.doesNotMatch(queueBlock, /\| 501 \| T501 \|/);
    assert.match(doc, /\| Implementation Limit \| 500 \|/);
    assert.match(doc, /\| View Limit \| 20000 \|/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("command queues use implementation and view limits separately", () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC" });
    writeFileSync(join(dir, ".tickets/tickets.yaml"), stringify({ tickets: makeDefs(600) }));

    const implementationRows = cmdImplementationQueue(dir);
    assert.equal(implementationRows.length, 500);
    assert.equal(implementationRows[499].ticket, "T500");
    assert.ok(!implementationRows.some((r) => r.ticket === "T501"));

    const viewRows = cmdQueue(dir);
    assert.equal(viewRows.length, 600);
    assert.equal(viewRows[599].ticket, "T600");

    const limitedViewRows = cmdQueue(dir, 3);
    assert.equal(limitedViewRows.length, 3);
    assert.equal(limitedViewRows[2].ticket, "T003");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("implementation queue with 505 tickets: completing T001 puts T501 into the 500-slot window", () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC" });
    writeFileSync(join(dir, ".tickets/tickets.yaml"), stringify({ tickets: makeDefs(505) }));

    let rows = cmdImplementationQueue(dir);
    assert.equal(rows.length, 500);
    assert.ok(rows.some((r) => r.ticket === "T500"));
    assert.ok(!rows.some((r) => r.ticket === "T501"));

    cmdComplete(dir, "T001", {
      actor: "test",
      summary: "done",
      validationResult: "passed",
      evidence: "tests pass",
    });

    rows = cmdImplementationQueue(dir);
    assert.equal(rows.length, 500);
    assert.ok(!rows.some((r) => r.ticket === "T001"), "T001 should leave queue");
    assert.ok(rows.some((r) => r.ticket === "T501"), "T501 should enter queue");
  } finally {
    rmSync(dir, { recursive: true });
  }
});
