import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildStartCommand, assertStartTicketPreflight, recordHandoffAcceptanceNotAttempted, savedStartArguments, selectDefaultExecutionTickets, validatePreparationArguments } from "../src/cli/start.js";
import type { TicketDef } from "../src/tickets/ticketSchema.js";
import type { TicketState } from "../src/tickets/stateDb.js";
import { cmdInit } from "../src/tickets/commands.js";
import { loadTicketsConfig, resolveTicketPaths } from "../src/tickets/config.js";
import { saveTickets } from "../src/tickets/ticketLoader.js";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createBuildRun } from "../src/buildRuns.js";
import { WorkflowDb } from "../src/workflowDb.js";

test("preparation persists actual parsed start options including repeatable tickets and negative flags", async () => {
  const command = buildStartCommand();
  let saved: string[] = [];
  command.action((_project, opts, cmd) => { saved = savedStartArguments(cmd, "/absolute/project", opts); });
  await command.parseAsync([".", "--steps", "9", "--no-qa", "--no-supervisor", "--ticket", "T001", "--ticket", "T002", "--model", "literal $(value)", "--tickets", "relative tickets.md"], { from: "user" });
  assert.deepEqual(saved.slice(0, 2), ["start", "/absolute/project"]);
  assert.equal(saved[saved.indexOf("--steps") + 1], "9");
  assert.equal(saved[saved.indexOf("--model") + 1], "literal $(value)");
  assert.ok(saved.includes("--no-qa"));
  assert.ok(saved.includes("--no-supervisor"));
  assert.equal(saved.filter(value => value === "--ticket").length, 2);
  assert.ok(!saved.includes("--qa"));
  assert.equal(saved[saved.indexOf("--tickets") + 1], resolve("relative tickets.md"));
});

for (const flags of [ ["--steps", "1", "--stacks", "1"], ["--steps", "1.5"], ["--steps", "1", "--effort", "invalid"], ["--steps", "1", "--autonomy", "invalid"], [], ["--stacks", "1", "--ticket", "T001"] ]) test(`saved preparation rejects invalid options ${flags.join(" ")}`, () => {
  assert.throws(() => validatePreparationArguments(["start", process.cwd(), ...flags], process.cwd()));
});

import { validateStartOptions, validateRecoveryArguments } from "../src/cli/start.js";
import { normalizeNestedLaunchArguments } from "../src/supervisedStart.js";
import { launchDigest } from "../src/buildAdmission.js";
test("established recovery accepts transferred token without preparation authority", () => {
  validateStartOptions({ steps: "1", recoverRun: "existing", launchToken: "token" }, true);
  validateStartOptions({ steps: "1", recoverRun: "existing" }, true);
  validateRecoveryArguments(["start", process.cwd(), "--steps", "1", "--recover-run", "existing"], process.cwd());
  for (const options of [{ launchToken: "orphan" }, { preparationRun: "missing-token" }, { preparationRun: "new", recoverRun: "existing", launchToken: "token" }]) {
    assert.throws(() => validateStartOptions({ steps: "1", ...options }, true));
  }
});
test("nested launch replaces outer capability without changing invocation digest", () => {
  const args = ["start", process.cwd(), "--steps", "1", "--recover-run", "existing", "--launch-token=outer"];
  const nested = normalizeNestedLaunchArguments(args, "inner");
  assert.deepEqual(nested.slice(-2), ["--launch-token", "inner"]);
  assert.ok(!nested.includes("--launch-token=outer"));
  const command = buildStartCommand(); command.parseOptions(nested.slice(2));
  validateStartOptions(command.opts(), true);
  assert.equal(launchDigest(savedStartArguments(command, process.cwd(), command.opts())), launchDigest(args.slice(0, -1)));
});

test("default start scans past a blocked implementation window to the first globally eligible tickets", () => {
  const ticket = (id: string, order: number, depends_on: string[] = []): TicketDef => ({
    id, order, title: id, area: "core", priority: "P1", size: "S", risk: "Low", depends_on,
    summary: id, acceptance: ["works"], required_tests: ["test"], likely_files: [],
  });
  const tickets = [ticket("T001", 1, ["T009"]), ticket("T002", 2), ticket("T003", 3)];
  const states = new Map([["T001", { status: "planned", blocked_by_json: "[]" }], ["T002", { status: "planned", blocked_by_json: '["external"]' }]] as const) as unknown as Map<string, TicketState>;
  assert.deepEqual(selectDefaultExecutionTickets(tickets, states, 1, 2), ["T003"]);
});

test("start preflight blocks unwaived ticket validation errors before runtime admission", () => {
  const project = mkdtempSync(join(tmpdir(), "rafi-start-preflight-"));
  cmdInit(project, { appName: "Preflight" });
  const paths = resolveTicketPaths(loadTicketsConfig(project), project);
  saveTickets(paths.tickets, [{
    id: "T001", order: 1, title: "Risk", area: "core", priority: "P1", size: "S", risk: "Medium", depends_on: [],
    summary: "Risk", acceptance: ["works"], required_tests: ["test"], likely_files: [], rollback: null,
  }]);
  assert.throws(() => assertStartTicketPreflight(project), /ticket\.risk\.rollback_required|rollback or mitigation plan/);
});

test("staged QA handoff records when runtime preparation prevents acceptance", () => {
  const project = mkdtempSync(join(tmpdir(), "rafi-handoff-not-attempted-"));
  execFileSync("git", ["init", "-q"], { cwd: project });
  execFileSync("git", ["config", "user.email", "test@example.test"], { cwd: project });
  execFileSync("git", ["config", "user.name", "Rafi test"], { cwd: project });
  writeFileSync(join(project, "source.txt"), "base\n");
  execFileSync("git", ["add", "source.txt"], { cwd: project });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: project });
  const run = createBuildRun({ repositoryRoot: project, tickets: ["T001"], qa: { role: "qa", source: "project", make: "codex", model: "default", reasoning: "default", fast: false } });
  try {
    recordHandoffAcceptanceNotAttempted(project, run.runId, "qa", 9, "qa-runtime-preparation", "runtime unavailable");
    const db = new WorkflowDb(project);
    try {
      const event = db.continuityEvents(run.runId).at(-1);
      assert.equal(event?.kind, "handoff_acceptance_not_attempted");
      assert.deepEqual(event?.payload, { generation: 9, role: "qa", stage: "qa-runtime-preparation", detail: "runtime unavailable" });
    } finally { db.close(); }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
