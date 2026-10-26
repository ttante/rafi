import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resetBuildState } from "../src/buildReset.js";

// better-sqlite3 is ai-foreman's dependency; resolve it from there.
const workflowDbUrl = import.meta.resolve("ai-foreman/workflow-db.js");
const Database = createRequire(fileURLToPath(workflowDbUrl))("better-sqlite3");
const sha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "rafi-build-reset-"));
  mkdirSync(join(dir, ".tickets"), { recursive: true });
  writeFileSync(join(dir, ".tickets", "config.yaml"), "app_name: Reset fixture\ntimezone: UTC\n", "utf8");
  writeFileSync(join(dir, ".tickets", "tickets.yaml"), [
    "tickets:", "  - id: T001", "    order: 1000", "    title: Ticket T001", "    area: Platform", "    priority: P1", "    size: S",
    "    risk: Low", "    depends_on: []", "    summary: Summary", "    acceptance: [It works]", "    required_tests: [Unit test]",
    "    likely_files: [src/*]", "    rollback: null", "    notes: null", "",
  ].join("\n"), "utf8");
  return dir;
}

const ownerScript = `const {WorkflowDb}=await import(process.argv[2]); const db=new WorkflowDb(process.argv[1]);
  db.acquireBuildAdmission('old-run','worker');
  db.planOperation({runId:'old-run',idempotencyKey:'old-turn',kind:'provider-dispatch',intent:{role:'builder',ticketId:'T001'}});
  if (process.argv[3] === 'hold') { console.log('ready'); setInterval(() => {}, 1000); } else db.close();`;

/** A child process takes build admission and plans a provider dispatch, then exits: a dead owner. */
function leaveDeadBuildOwner(dir: string): void {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", ownerScript, dir, workflowDbUrl], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
}

/** Simulate a database written before the structured-communication v2 cutover. */
function markCutoverPending(dir: string): void {
  const db = new Database(join(dir, ".rafi", "recovery.sqlite3"));
  // Guard triggers call these host functions; register them as a current writer would.
  db.function("rafi_protocol_v3", () => 1);
  db.function("rafi_writer_protocol", () => 4);
  db.function("rafi_structured_communication_protocol", () => 2);
  db.function("rafi_structured_authority_revision", () => 3);
  db.exec("DELETE FROM structured_communication_cutover");
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
}

test("build:reset archives a pre-cutover database left with a dead build admission without migrating it", () => {
  const dir = project();
  try {
    leaveDeadBuildOwner(dir);
    markCutoverPending(dir);
    const before = sha(join(dir, ".rafi", "recovery.sqlite3"));
    const result = resetBuildState(dir);
    assert.deepEqual(result.tickets, ["T001"]);
    assert.equal(sha(join(result.archiveDir, "recovery.sqlite3")), before, "the archived database must be untouched");
    // The next writer starts from a fresh, fully cut-over database.
    const fresh = new Database(join(dir, ".rafi", "recovery.sqlite3"), { readonly: true });
    try {
      assert.equal(fresh.prepare("SELECT count(*) AS n FROM build_admission").get().n, 0);
      assert.ok(fresh.prepare("SELECT 1 FROM structured_communication_cutover").get());
    } finally { fresh.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("build:reset still refuses while the admission owner is alive", async () => {
  const dir = project();
  const owner = spawn(process.execPath, ["--input-type=module", "-e", ownerScript, dir, workflowDbUrl, "hold"], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    await new Promise<void>((done, fail) => {
      owner.stdout.on("data", chunk => { if (String(chunk).includes("ready")) done(); });
      owner.on("exit", code => fail(new Error(`owner exited early (${code})`)));
    });
    assert.throws(() => resetBuildState(dir), /live or unverified Rafi process owns the project \(build-admission/);
    assert.ok(existsSync(join(dir, ".rafi", "recovery.sqlite3")), "nothing is archived on refusal");
  } finally {
    owner.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
