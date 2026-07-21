import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";

import { buildNextQueue } from "../src/tickets/queue.js";
import { computeDisplayStatus, resolveBlockers } from "../src/tickets/blockers.js";
import { validateTicketDefs, detectCycles } from "../src/tickets/ticketLoader.js";
import { cmdInit, cmdUpdate, cmdComplete, cmdBlock, cmdQueue, cmdDiscover, cmdValidate } from "../src/tickets/commands.js";
import { Log } from "../src/log.js";
import {
  buildPopulateAgentRunOptions,
  buildPopulateInstruction,
  resolvePopulateSources,
} from "../src/cli/tickets.js";
import { loadTicketsConfig } from "../src/tickets/config.js";
import type { TicketDef } from "../src/tickets/ticketSchema.js";
import type { TicketState } from "../src/tickets/stateDb.js";

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

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "foreman-tickets-test-"));
}

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

test("queue with 55 tickets: completing T001 puts T051 into the 50-slot window", () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC" });
    const defs = Array.from({ length: 55 }, (_, i) =>
      makeDef(`T${String(i + 1).padStart(3, "0")}`, (i + 1) * 1000),
    );
    writeFileSync(join(dir, ".tickets/tickets.yaml"), stringify({ tickets: defs }));

    let rows = cmdQueue(dir);
    assert.equal(rows.length, 50);
    assert.ok(rows.some((r) => r.ticket === "T050"));
    assert.ok(!rows.some((r) => r.ticket === "T051"));

    cmdComplete(dir, "T001", {
      actor: "test",
      summary: "done",
      validationResult: "passed",
      evidence: "tests pass",
    });

    rows = cmdQueue(dir);
    assert.equal(rows.length, 50);
    assert.ok(!rows.some((r) => r.ticket === "T001"), "T001 should leave queue");
    assert.ok(rows.some((r) => r.ticket === "T051"), "T051 should enter queue");
  } finally {
    rmSync(dir, { recursive: true });
  }
});
