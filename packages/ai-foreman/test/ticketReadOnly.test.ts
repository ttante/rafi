import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { cmdInit, cmdQueue, cmdValidate } from "../src/tickets/commands.js";
import { getAllTicketDetails } from "../src/tickets/details.js";
import { buildTicketsCommand } from "../src/cli/tickets.js";
import { WorkflowDb } from "../src/workflowDb.js";
import { makeLegacyWorkFixture } from "./helpers/legacyWork.js";
import Database from "better-sqlite3";
import { registerHandbackWriter } from "../src/qaHandbackMigration.js";

test("ticket inspection leaves legacy workflow and tracker bytes unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-ticket-reads-"));
  try {
    cmdInit(root, { appName: "Read fixture" });
    writeFileSync(join(root, ".tickets/tickets.yaml"), stringify({ tickets: [{ id: "T1", order: 1000, title: "Read", area: "Core", priority: "P1", size: "S", risk: "Low", depends_on: [], summary: "Read", acceptance: ["Works"], required_tests: ["Unit"], likely_files: [], rollback: null, notes: null }] }));
    const workflow = new WorkflowDb(root); const path = workflow.path; workflow.close();
    makeLegacyWorkFixture(path);
    const legacy = new Database(path);
    registerHandbackWriter(legacy);
    legacy.function("rafi_protocol_v3", () => 1);
    legacy.function("rafi_build_writer_run", () => "");
    legacy.function("rafi_build_writer_token", () => "");
    legacy.function("rafi_build_lease_owner", () => "");
    legacy.function("rafi_build_lease_generation", () => -1);
    legacy.prepare("INSERT INTO build_admission VALUES(1,?)").run(JSON.stringify({ pid: 10817, host: "remote-fixture.invalid", processStart: "old process", runId: "old-run", project: "/old/project" }));
    legacy.close();
    const statePath = join(root, ".tickets/ticket-state.sqlite");
    const before = [readFileSync(path), readFileSync(statePath)];
    assert.equal(cmdQueue(root).length, 1);
    cmdValidate(root);
    assert.equal(getAllTicketDetails(root).ticket_count, 1);
    await buildTicketsCommand().parseAsync(["node", "test", "queue", "--project", root]);
    assert.deepEqual(readFileSync(path), before[0]);
    assert.deepEqual(readFileSync(statePath), before[1]);
    renameSync(statePath, `${statePath}.saved`);
    const missingHistory = cmdValidate(root);
    assert.equal(missingHistory.clean, false);
    assert.ok(missingHistory.issues.some(issue => /history database is missing/.test(issue.message)));
    assert.equal(existsSync(statePath), false, "read-only inspection must not recreate lost history");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
