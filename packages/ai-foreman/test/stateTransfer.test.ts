import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { stringify } from "yaml";
import { cmdInit, cmdUpdate } from "../src/tickets/commands.js";
import { StateDb } from "../src/tickets/stateDb.js";
import { WorkflowDb } from "../src/workflowDb.js";
import { exportStateBundle, fingerprintState, importStateBundle, inspectStateBundle, STATE_LINEAGE_PATH } from "../src/stateTransfer.js";

function tempDir(prefix = "rafi-state-transfer-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeRafiConfig(dir: string): void {
  writeFileSync(join(dir, "rafi-config.yaml"), "app: test\n", "utf8");
}

function readArchive(path: string): any {
  return JSON.parse(gunzipSync(readFileSync(path)).toString("utf8"));
}

function writeArchive(path: string, archive: any): void {
  writeFileSync(path, gzipSync(Buffer.from(JSON.stringify(archive), "utf8")));
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function initGit(dir: string): void {
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test User"]);
  writeFileSync(join(dir, "README.md"), "hello\n", "utf8");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-m", "initial"]);
}

function oneTicketYaml(id = "T001"): string {
  return stringify({ tickets: [{ id, order: 1000, title: "One", area: "Core", priority: "P1", size: "S", risk: "Low", depends_on: [], summary: "Do one", acceptance: ["done"], required_tests: ["test"], likely_files: [], rollback: null, notes: null }] });
}

test("state export includes manifest, diagnostics, compiled bundles, source cache, and sqlite backups without WAL sidecars", async () => {
  const dir = tempDir();
  const bundle = join(tempDir(), "state.rafi.gz");
  try {
    writeRafiConfig(dir);
    cmdInit(dir, { appName: "State App", timezone: "UTC" });
    writeFileSync(join(dir, ".tickets", "tickets.yaml"), stringify({ tickets: [{ id: "T001", order: 1000, title: "One", area: "Core", priority: "P1", size: "S", risk: "Low", depends_on: [], summary: "Do one", acceptance: ["done"], required_tests: ["test"], likely_files: [], rollback: null, notes: null }] }), "utf8");
    cmdUpdate(dir, "T001", { status: "done", evidence: "ok", validationResult: "passed" });
    mkdirSync(join(dir, ".rafi", "compiled", "builder"), { recursive: true });
    writeFileSync(join(dir, ".rafi", "compiled", "builder", "system.md"), "compiled\n", "utf8");
    mkdirSync(join(dir, ".rafi", "source-cache", "src_1"), { recursive: true });
    writeFileSync(join(dir, ".rafi", "source-cache", "src_1", "snapshot.md"), "source\n", "utf8");
    mkdirSync(join(dir, ".foreman"), { recursive: true });
    writeFileSync(join(dir, ".foreman", "run.jsonl"), "{}\n", "utf8");
    mkdirSync(join(dir, ".foreman", "worktrees", "run-1"), { recursive: true });
    writeFileSync(join(dir, ".foreman", "worktrees", "run-1", "source.ts"), "do not bundle\n", "utf8");
    const obs = new Database(join(dir, ".rafi", "observability.sqlite3"));
    obs.pragma("journal_mode = WAL");
    obs.exec("CREATE TABLE sample(value TEXT); INSERT INTO sample(value) VALUES('observed')");
    obs.close();

    const manifest = await exportStateBundle(dir, bundle, { packageVersion: "test" });
    const inspected = inspectStateBundle(bundle).manifest;
    assert.equal(inspected.bundleId, manifest.bundleId);
    assert.ok(inspected.files.some((file) => file.path === ".tickets/ticket-state.sqlite" && file.kind === "sqlite"));
    assert.ok(inspected.files.some((file) => file.path === ".rafi/observability.sqlite3" && file.kind === "sqlite"));
    assert.ok(inspected.files.some((file) => file.path === ".rafi/compiled/builder/system.md"));
    assert.ok(inspected.files.some((file) => file.path === ".rafi/source-cache/src_1/snapshot.md"));
    assert.ok(inspected.files.some((file) => file.path === ".foreman/run.jsonl"));
    assert.equal(inspected.files.some((file) => file.path.startsWith(".foreman/worktrees/")), false);
    assert.equal(inspected.files.some((file) => file.path.endsWith("-wal") || file.path.endsWith("-shm")), false);
    assert.ok(inspected.lineage?.baseFingerprint);
    assert.equal(inspected.lineage?.sourceCurrentFingerprint, inspected.source.fingerprint);
    assert.ok(existsSync(join(dir, STATE_LINEAGE_PATH)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(bundle, { force: true });
  }
});

test("state import restores sqlite state and rewrites current project-local paths", async () => {
  const source = tempDir("rafi-state-source-");
  const target = tempDir("rafi-state-target-");
  const bundle = join(tempDir(), "state.rafi.gz");
  try {
    writeRafiConfig(source);
    writeRafiConfig(target);
    cmdInit(source, { appName: "State App", timezone: "UTC" });
    writeFileSync(join(source, ".tickets", "tickets.yaml"), stringify({ tickets: [{ id: "T001", order: 1000, title: "One", area: "Core", priority: "P1", size: "S", risk: "Low", depends_on: [], summary: "Do one", acceptance: ["done"], required_tests: ["test"], likely_files: [], rollback: null, notes: null }] }), "utf8");
    cmdUpdate(source, "T001", { status: "done", evidence: "ok", validationResult: "passed" });
    const workflow = new WorkflowDb(source);
    workflow.createRun({ runId: "run-1", kind: "build", state: { worktree: source, qaReportRecovery: { packetPath: join(source, ".foreman", "qa-report-recovery", "packet") } } });
    workflow.admitWork({runId:"run-1",kind:"ticket",ticketId:"T001",definition:{id:"T001"},approvalId:"fixture",scopeRevision:"fixture",provenance:{userTurn:"Build T001",reason:"Authorized branch transfer fixture"}});
    workflow.recordBranchResumeSession("run-1", { ticket: "T001", branch: "feature/t1", base: "main", worktreePath: join(source, ".foreman", "worktrees", "run-1", "feature__t1"), sessionId: "provider-session", logPath: join(source, ".foreman", "run.jsonl") });
    workflow.close();
    mkdirSync(join(source, ".foreman", "runs"), { recursive: true });
    writeFileSync(join(source, ".foreman", "runs", "run-1.json"), JSON.stringify({ runId: "run-1", repository: { root: source, worktree: source }, worktreePath: join(source, ".foreman", "worktrees", "run-1") }, null, 2), "utf8");

    await exportStateBundle(source, bundle, { packageVersion: "test" });
    const result = await importStateBundle(target, bundle, { yes: true });
    assert.equal(result.manifest.source.root, source);
    const db = new StateDb(join(target, ".tickets", "ticket-state.sqlite"));
    assert.equal(db.getState("T001")?.status, "done");
    db.close();
    const run = JSON.parse(readFileSync(join(target, ".foreman", "runs", "run-1.json"), "utf8"));
    assert.equal(run.repository.root, target);
    assert.equal(run.repository.worktree, target);
    assert.equal(run.worktreePath, join(target, ".foreman", "worktrees", "run-1"));
    const importedWorkflow = new WorkflowDb(target);
    assert.equal(importedWorkflow.branchResumeSessions()[0]?.worktreePath, join(target, ".foreman", "worktrees", "run-1", "feature__t1"));
    importedWorkflow.close();
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
    rmSync(bundle, { force: true });
  }
});

test("state inspect rejects digest mismatches", async () => {
  const dir = tempDir();
  const bundle = join(tempDir(), "state.rafi.gz");
  try {
    writeRafiConfig(dir);
    cmdInit(dir, { appName: "State App", timezone: "UTC" });
    writeFileSync(join(dir, ".tickets", "tickets.yaml"), stringify({ tickets: [] }), "utf8");
    await exportStateBundle(dir, bundle, { packageVersion: "test" });
    const archive = readArchive(bundle);
    const entry = archive.entries.find((item: any) => item.path === ".tickets/tickets.yaml");
    entry.data = Buffer.from("tampered\n").toString("base64");
    writeArchive(bundle, archive);
    assert.throws(() => inspectStateBundle(bundle), /(?:digest|size) mismatch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(bundle, { force: true });
  }
});

test("state import refuses target state that advanced after last lineage", async () => {
  const source = tempDir("rafi-state-source-");
  const target = tempDir("rafi-state-target-");
  const bundle = join(tempDir(), "state.rafi.gz");
  try {
    writeRafiConfig(source);
    writeRafiConfig(target);
    cmdInit(source, { appName: "State App", timezone: "UTC" });
    writeFileSync(join(source, ".tickets", "tickets.yaml"), stringify({ tickets: [] }), "utf8");
    await exportStateBundle(source, bundle, { packageVersion: "test" });
    await importStateBundle(target, bundle, { yes: true });
    writeFileSync(join(target, ".tickets", "tickets.yaml"), stringify({ tickets: [{ id: "T999" }] }), "utf8");
    await assert.rejects(() => importStateBundle(target, bundle, { yes: true }), /advanced since the last state transfer/);
    assert.notEqual(fingerprintState(target), JSON.parse(readFileSync(join(target, STATE_LINEAGE_PATH), "utf8")).currentFingerprint);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
    rmSync(bundle, { force: true });
  }
});

test("state import refuses Git branch and HEAD mismatches", async () => {
  const source = tempDir("rafi-state-source-git-");
  const target = tempDir("rafi-state-target-git-");
  const bundle = join(tempDir(), "state.rafi.gz");
  try {
    initGit(source);
    initGit(target);
    writeRafiConfig(source);
    writeRafiConfig(target);
    cmdInit(source, { appName: "State App", timezone: "UTC" });
    writeFileSync(join(source, ".tickets", "tickets.yaml"), stringify({ tickets: [] }), "utf8");
    git(source, ["checkout", "-b", "feature"]);
    git(source, ["add", "."]);
    git(source, ["commit", "-m", "state"]);
    git(target, ["add", "."]);
    git(target, ["commit", "-m", "state"]);
    await exportStateBundle(source, bundle, { packageVersion: "test" });
    await assert.rejects(() => importStateBundle(target, bundle, { yes: true }), /branch mismatch/);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
    rmSync(bundle, { force: true });
  }
});

test("state inspect rejects extra, duplicate, and unallowed archive entries", async () => {
  const dir = tempDir();
  const bundle = join(tempDir(), "state.rafi.gz");
  try {
    writeRafiConfig(dir);
    cmdInit(dir, { appName: "State App", timezone: "UTC" });
    writeFileSync(join(dir, ".tickets", "tickets.yaml"), stringify({ tickets: [] }), "utf8");
    await exportStateBundle(dir, bundle, { packageVersion: "test" });

    const extra = readArchive(bundle);
    extra.entries.push({ path: ".foreman/worktrees/run/source.ts", data: Buffer.from("source\n").toString("base64") });
    writeArchive(bundle, extra);
    assert.throws(() => inspectStateBundle(bundle), /unmanifested|allowlist/);

    await exportStateBundle(dir, bundle, { packageVersion: "test" });
    const duplicateEntry = readArchive(bundle);
    duplicateEntry.entries.push({ ...duplicateEntry.entries.find((entry: any) => entry.path === ".tickets/tickets.yaml") });
    writeArchive(bundle, duplicateEntry);
    assert.throws(() => inspectStateBundle(bundle), /duplicate bundle archive entry/);

    await exportStateBundle(dir, bundle, { packageVersion: "test" });
    const duplicateManifest = readArchive(bundle);
    const manifestEntry = duplicateManifest.entries.find((entry: any) => entry.path === "rafi-state-manifest.v1.json");
    const manifest = JSON.parse(Buffer.from(manifestEntry.data, "base64").toString("utf8"));
    manifest.files.push({ ...manifest.files[0] });
    manifestEntry.data = Buffer.from(JSON.stringify(manifest)).toString("base64");
    writeArchive(bundle, duplicateManifest);
    assert.throws(() => inspectStateBundle(bundle), /duplicate manifest file path/);

    await exportStateBundle(dir, bundle, { packageVersion: "test" });
    const unallowedManifest = readArchive(bundle);
    const unallowedManifestEntry = unallowedManifest.entries.find((entry: any) => entry.path === "rafi-state-manifest.v1.json");
    const unallowed = JSON.parse(Buffer.from(unallowedManifestEntry.data, "base64").toString("utf8"));
    unallowed.files[0] = { ...unallowed.files[0], path: ".codex/config.toml" };
    unallowedManifestEntry.data = Buffer.from(JSON.stringify(unallowed)).toString("base64");
    writeArchive(bundle, unallowedManifest);
    assert.throws(() => inspectStateBundle(bundle), /outside the Rafi state transfer allowlist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(bundle, { force: true });
  }
});

test("state import refuses divergent A/B/C lineage", async () => {
  const a = tempDir("rafi-state-a-");
  const b = tempDir("rafi-state-b-");
  const c = tempDir("rafi-state-c-");
  const baseBundle = join(tempDir(), "base.rafi.gz");
  const cBundle = join(tempDir(), "c.rafi.gz");
  try {
    writeRafiConfig(a);
    cmdInit(a, { appName: "State App", timezone: "UTC" });
    writeFileSync(join(a, ".tickets", "tickets.yaml"), oneTicketYaml("T001"), "utf8");
    await exportStateBundle(a, baseBundle, { packageVersion: "test" });

    await importStateBundle(b, baseBundle, { yes: true });
    writeFileSync(join(b, ".tickets", "tickets.yaml"), oneTicketYaml("B001"), "utf8");
    await exportStateBundle(b, join(tempDir(), "b.rafi.gz"), { packageVersion: "test" });

    await importStateBundle(c, baseBundle, { yes: true });
    writeFileSync(join(c, ".tickets", "tickets.yaml"), oneTicketYaml("C001"), "utf8");
    await exportStateBundle(c, cBundle, { packageVersion: "test" });

    await assert.rejects(() => importStateBundle(b, cBundle, { yes: true }), /diverges from the target state lineage/);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
    rmSync(c, { recursive: true, force: true });
    rmSync(baseBundle, { force: true });
    rmSync(cBundle, { force: true });
  }
});

test("state export and import refuse dirty Git checkouts", async () => {
  const source = tempDir("rafi-state-source-dirty-");
  const target = tempDir("rafi-state-target-dirty-");
  const bundle = join(tempDir(), "state.rafi.gz");
  try {
    initGit(source);
    writeRafiConfig(source);
    cmdInit(source, { appName: "State App", timezone: "UTC" });
    writeFileSync(join(source, ".tickets", "tickets.yaml"), stringify({ tickets: [] }), "utf8");
    await assert.rejects(() => exportStateBundle(source, bundle, { packageVersion: "test" }), /dirty Git checkout/);
    git(source, ["add", "."]);
    git(source, ["commit", "-m", "state"]);
    await exportStateBundle(source, bundle, { packageVersion: "test" });

    initGit(target);
    writeRafiConfig(target);
    writeFileSync(join(target, "dirty.txt"), "dirty\n", "utf8");
    await assert.rejects(() => importStateBundle(target, bundle, { yes: true }), /dirty Git checkout/);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
    rmSync(bundle, { force: true });
  }
});

test("state import refuses a live workflow lease", async () => {
  const source = tempDir("rafi-state-source-lease-");
  const target = tempDir("rafi-state-target-lease-");
  const bundle = join(tempDir(), "state.rafi.gz");
  try {
    writeRafiConfig(source);
    cmdInit(source, { appName: "State App", timezone: "UTC" });
    writeFileSync(join(source, ".tickets", "tickets.yaml"), stringify({ tickets: [] }), "utf8");
    await exportStateBundle(source, bundle, { packageVersion: "test" });
    const db = new WorkflowDb(target);
    db.createRun({ runId: "run-live", kind: "build", state: {} });
    db.acquireLease("run-live");
    db.close();
    await assert.rejects(() => importStateBundle(target, bundle, { yes: true }), /live workflow lease/);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
    rmSync(bundle, { force: true });
  }
});

test("state import refuses DB-era ticket artifacts without ticket database", async () => {
  const source = tempDir("rafi-state-source-missing-db-");
  const target = tempDir("rafi-state-target-missing-db-");
  const bundle = join(tempDir(), "state.rafi.gz");
  try {
    writeRafiConfig(source);
    cmdInit(source, { appName: "State App", timezone: "UTC" });
    writeFileSync(join(source, ".tickets", "tickets.yaml"), stringify({ tickets: [] }), "utf8");
    await exportStateBundle(source, bundle, { packageVersion: "test" });
    const archive = readArchive(bundle);
    archive.entries = archive.entries.filter((entry: any) => entry.path !== ".tickets/ticket-state.sqlite");
    const manifestEntry = archive.entries.find((entry: any) => entry.path === "rafi-state-manifest.v1.json");
    const manifest = JSON.parse(Buffer.from(manifestEntry.data, "base64").toString("utf8"));
    manifest.files = manifest.files.filter((file: any) => file.path !== ".tickets/ticket-state.sqlite");
    manifestEntry.data = Buffer.from(JSON.stringify(manifest)).toString("base64");
    writeArchive(bundle, archive);
    await assert.rejects(() => importStateBundle(target, bundle, { yes: true }), /DB-backed ticket state is required/);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
    rmSync(bundle, { force: true });
  }
});

test("state import rollback restores replaced state and removes newly imported files", async () => {
  const oldSource = tempDir("rafi-state-old-rollback-");
  const source = tempDir("rafi-state-source-rollback-");
  const target = tempDir("rafi-state-target-rollback-");
  const baseBundle = join(tempDir(), "base.rafi.gz");
  const bundle = join(tempDir(), "state.rafi.gz");
  try {
    writeRafiConfig(oldSource);
    cmdInit(oldSource, { appName: "State App", timezone: "UTC" });
    writeFileSync(join(oldSource, ".tickets", "tickets.yaml"), oneTicketYaml("OLD"), "utf8");
    mkdirSync(join(oldSource, ".foreman"), { recursive: true });
    writeFileSync(join(oldSource, ".foreman", "old.jsonl"), "old\n", "utf8");
    await exportStateBundle(oldSource, baseBundle, { packageVersion: "test" });

    await importStateBundle(source, baseBundle, { yes: true });
    writeFileSync(join(source, ".tickets", "tickets.yaml"), oneTicketYaml("NEW"), "utf8");
    writeFileSync(join(source, ".foreman", "new.jsonl"), "new\n", "utf8");
    mkdirSync(join(source, ".foreman", "runs"), { recursive: true });
    writeFileSync(join(source, ".foreman", "runs", "bad.json"), "{bad json", "utf8");
    mkdirSync(join(source, ".rafi", "compiled"), { recursive: true });
    writeFileSync(join(source, ".rafi", "compiled", "new.md"), "new\n", "utf8");
    await exportStateBundle(source, bundle, { packageVersion: "test" });

    await importStateBundle(target, baseBundle, { yes: true });
    writeFileSync(join(target, "outside.txt"), "untouched\n", "utf8");

    await assert.rejects(() => importStateBundle(target, bundle, { yes: true }), /JSON/);
    assert.match(readFileSync(join(target, ".tickets", "tickets.yaml"), "utf8"), /OLD/);
    assert.equal(existsSync(join(target, ".rafi", "compiled", "new.md")), false);
    assert.equal(existsSync(join(target, ".foreman", "new.jsonl")), false);
    assert.equal(readFileSync(join(target, ".foreman", "old.jsonl"), "utf8"), "old\n");
    assert.equal(readFileSync(join(target, "outside.txt"), "utf8"), "untouched\n");
  } finally {
    rmSync(oldSource, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
    rmSync(baseBundle, { force: true });
    rmSync(bundle, { force: true });
  }
});

test("state export refuses DB-era tickets without ticket-state sqlite", async () => {
  const dir = tempDir();
  const bundle = join(tempDir(), "state.rafi.gz");
  try {
    mkdirSync(join(dir, ".tickets"), { recursive: true });
    writeFileSync(join(dir, ".tickets", "tickets.yaml"), stringify({ tickets: [] }), "utf8");
    await assert.rejects(() => exportStateBundle(dir, bundle, { packageVersion: "test" }), /DB-backed ticket state is required/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(bundle, { force: true });
  }
});

test("state export refuses live preparation before an implementation lease exists", async () => {
  const root = tempDir();
  const bundleDir = tempDir();
  const db = new WorkflowDb(root);
  try {
    const authority = db.acquireBuildAdmission("preparing", "worker");
    assert.equal(db.currentLease(), undefined);
    await assert.rejects(exportStateBundle(root, join(bundleDir, "state.rafi.gz")), /live or unknown build admission/);
    db.releaseBuildAdmission(authority);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); rmSync(bundleDir, { recursive: true, force: true }); }
});
