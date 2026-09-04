import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { stringify } from "yaml";

import { cmdInit } from "../src/tickets/commands.js";
import { formatTicketDetails, getTicketDetails } from "../src/tickets/details.js";
import { StateDb } from "../src/tickets/stateDb.js";
import type { TicketDef } from "../src/tickets/ticketSchema.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(packageRoot, "src", "index.ts");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "foreman-show-cli-test-"));
}

function tsxBin(): string {
  const local = join(packageRoot, "node_modules", ".bin", "tsx");
  return existsSync(local) ? local : resolve(packageRoot, "..", "..", "node_modules", ".bin", "tsx");
}

function definition(id: string, order: number): TicketDef {
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
  };
}

function run(cwd: string, args: string[]) {
  return spawnSync(tsxBin(), [entry, "tickets", "show", ...args], { cwd, encoding: "utf8" });
}

test("tickets show CLI requires exactly one selection mode", () => {
  const dir = tempDir();
  try {
    cmdInit(dir, { appName: "CLI selection", timezone: "UTC" });
    writeFileSync(join(dir, ".tickets", "tickets.yaml"), stringify({ tickets: [definition("T001", 1000)] }), "utf8");

    const neither = run(dir, ["--project", dir]);
    assert.notEqual(neither.status, 0);
    assert.match(neither.stderr, /rafi tickets show T123/);
    assert.match(neither.stderr, /rafi tickets show --all/);

    const both = run(dir, ["T001", "--all", "--project", dir]);
    assert.notEqual(both.status, 0);
    assert.match(both.stderr, /either a ticket ID or --all/);
  } finally { rmSync(dir, { recursive: true }); }
});

test("tickets show CLI preserves single output and emits the versioned all-ticket JSON envelope", () => {
  const dir = tempDir();
  try {
    cmdInit(dir, { appName: "CLI rendering", timezone: "UTC" });
    writeFileSync(join(dir, ".tickets", "tickets.yaml"), stringify({ tickets: [definition("T002", 2000), definition("T001", 1000)] }), "utf8");
    const db = new StateDb(join(dir, ".tickets", "ticket-state.sqlite"));
    db.upsertState("T001", { status: "planned" }, "2026-01-01T00:00:00.000Z");
    db.close();

    const expectedSingle = `${formatTicketDetails(getTicketDetails(dir, "T001")).join("\n")}\n`;
    const single = run(dir, ["T001", "--project", dir]);
    assert.equal(single.status, 0, single.stderr);
    assert.equal(single.stdout, expectedSingle);

    const singleJson = run(dir, ["T001", "--json", "--project", dir]);
    assert.equal(singleJson.status, 0, singleJson.stderr);
    const parsedSingle = JSON.parse(singleJson.stdout) as Record<string, unknown>;
    assert.equal((parsedSingle.definition as { id: string }).id, "T001");
    assert.equal("version" in parsedSingle, false);

    const all = run(dir, ["--all", "--json", "--project", dir]);
    assert.equal(all.status, 0, all.stderr);
    const parsed = JSON.parse(all.stdout) as { version: number; generated_at: string; ticket_count: number; tickets: Array<{ definition: { id: string } }> };
    assert.equal(parsed.version, 1);
    assert.match(parsed.generated_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(parsed.ticket_count, 2);
    assert.deepEqual(parsed.tickets.map((ticket) => ticket.definition.id), ["T001", "T002"]);
  } finally { rmSync(dir, { recursive: true }); }
});

test("tickets show CLI appends single and bulk payloads without duplicating them on stdout", () => {
  const root = tempDir();
  const project = join(root, "project");
  const invocation = join(root, "invocation");
  try {
    mkdirSync(project);
    mkdirSync(invocation);
    cmdInit(project, { appName: "CLI output", timezone: "UTC" });
    writeFileSync(join(project, ".tickets", "tickets.yaml"), stringify({ tickets: [definition("T001", 1000), definition("T002", 2000)] }), "utf8");
    const relativeOutput = join("context", "agent-context.txt");
    const absoluteOutput = join(invocation, relativeOutput);

    const created = run(invocation, ["--all", "--json", "--project", project, "--output", relativeOutput]);
    assert.equal(created.status, 0, created.stderr);
    assert.equal(created.stdout, `rafi tickets show: created 2 tickets as json to ${absoluteOutput}\n`);
    const original = readFileSync(absoluteOutput, "utf8");
    assert.equal((JSON.parse(original) as { ticket_count: number }).ticket_count, 2);

    const appended = run(invocation, ["T001", "--project", project, "--output", relativeOutput]);
    assert.equal(appended.status, 0, appended.stderr);
    assert.equal(appended.stdout, `rafi tickets show: appended 1 ticket as text to ${absoluteOutput}\n`);
    const combined = readFileSync(absoluteOutput, "utf8");
    assert.ok(combined.startsWith(original));
    assert.equal(combined.at(original.length), "\n");
    assert.match(combined.slice(original.length + 1), /^T001: Ticket T001/);
    assert.doesNotMatch(appended.stdout, /T001: Ticket T001/);
  } finally { rmSync(root, { recursive: true }); }
});
