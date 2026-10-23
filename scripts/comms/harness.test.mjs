import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommands, pnpmCommand } from "./baseline.mjs";
import { CodexRpc, probeConfig, providerVersions } from "../live/structured-output-support.mjs";
import { completedJourneyTickets } from "../live/journey-completion.mjs";
import { verifyFrozenCli } from "../live/frozen-cli.mjs";

test("completed-unit continuation rejects a modified frozen candidate", () => {
  const root = mkdtempSync(join(tmpdir(), "frozen-candidate-"));
  try {
    const path = "packages/rafi/dist/index.js";
    mkdirSync(join(root, "packages/rafi/dist"), { recursive: true });
    writeFileSync(join(root, path), "original");
    const files = [[path, createHash("sha256").update("original").digest("hex")]];
    const digest = createHash("sha256").update(JSON.stringify(files)).digest("hex");
    writeFileSync(join(root, "build-manifest.json"), JSON.stringify({ files, digest }));
    assert.equal(verifyFrozenCli(root).digest, digest);
    writeFileSync(join(root, path), "changed");
    assert.throws(() => verifyFrozenCli(root), /modified/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("live completion requires a ticket's consumed certificate and matching completed finalization", () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-journey-certificates-"));
  const Database = createRequire(new URL("../../packages/ai-foreman/package.json", import.meta.url))("better-sqlite3");
  mkdirSync(join(root, ".rafi"));
  const db = new Database(join(root, ".rafi/recovery.sqlite3"));
  try {
    db.exec(`CREATE TABLE qa_pass_certificates(certificate_id TEXT,run_id TEXT,ticket_id TEXT,consumed_at TEXT,consumed_by TEXT);
      CREATE TABLE qa_finalization_steps(certificate_id TEXT,run_id TEXT,ticket_id TEXT,kind TEXT,status TEXT);
      INSERT INTO qa_pass_certificates VALUES('cert','run','T001',NULL,NULL);
      INSERT INTO qa_finalization_steps VALUES('cert','run','T001','ticket-complete:T001','intended');`);
    assert.deepEqual(completedJourneyTickets(root), []);
    db.exec("UPDATE qa_pass_certificates SET consumed_at='now',consumed_by='ticket-complete:T001'");
    assert.deepEqual(completedJourneyTickets(root), []);
    db.exec("UPDATE qa_finalization_steps SET status='completed',run_id='foreign'");
    assert.deepEqual(completedJourneyTickets(root), []);
    db.exec("UPDATE qa_finalization_steps SET run_id='run'");
    assert.deepEqual(completedJourneyTickets(root), [{ ticketId: "T001", runId: "run", certificateId: "cert" }]);
    db.exec("UPDATE qa_pass_certificates SET consumed_by='invalidated:source-changed'");
    assert.deepEqual(completedJourneyTickets(root), []);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("failed prerequisite stops the baseline before stale build artifacts can be tested", async () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-baseline-audit-"));
  const report = { results: [] };
  try {
    const result = await runCommands([
      ["build", process.execPath, ["-e", "process.exit(7)"]],
      ["journeys", process.execPath, ["-e", "process.exit(0)"]],
    ], { root, evidence: root, report, save() {} });
    assert.equal(result, false);
    assert.equal(report.results.length, 1);
    assert.equal(report.results[0].exitCode, 7);
    assert.equal(existsSync(join(root, "journeys.log")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pnpm launches its JS entry directly on Windows without a command shell", () => {
  const entry = "C:/Program Files/pnpm/bin/pnpm.cjs";
  assert.deepEqual(pnpmCommand(["-r", "build"], { npm_execpath: entry }, "win32"), [process.execPath, [entry, "-r", "build"]]);
  assert.throws(() => pnpmCommand([], {}, "win32"), /pnpm baseline:comms/);
});

test("probe rejects repeated providers and calculates bounds for the selected profile", () => {
  const env = { RAFI_LIVE_STRUCTURED: "1", RAFI_LIVE_DEADLINE: new Date(Date.now() + 60_000).toISOString() };
  assert.throws(() => probeConfig({ ...env, RAFI_LIVE_PROVIDERS: "codex,codex" }), /Duplicate providers/);
  assert.equal(probeConfig(env).maximumHostDispatches, 9);
  assert.equal(probeConfig({ ...env, RAFI_LIVE_PROVIDERS: "codex" }).maximumHostDispatches, 5);
  assert.equal(probeConfig({ ...env, RAFI_LIVE_PROVIDERS: "claude", RAFI_LIVE_STRUCTURED_PROFILE: "contracts" }).maximumHostDispatches, 3);
});

test("single-provider probe does not require the unselected CLI", () => {
  const calls = [];
  assert.deepEqual(providerVersions(["codex"], command => {
    calls.push(command); assert.equal(command, "codex"); return "fixture-version\n";
  }), { codex: "fixture-version" });
  assert.deepEqual(calls, ["codex"]);
});

test("failed app-server spawn rejects RPC and closes without waiting for an absent exit event", { timeout: 5000 }, async () => {
  const rpc = new CodexRpc({ cwd: process.cwd(), remaining: () => 1000, executable: join(tmpdir(), "rafi-nonexistent-app-server") });
  try { await assert.rejects(rpc.initialize(), /ENOENT|not running/); }
  finally { await rpc.close(); }
  assert.equal(rpc.pending.size, 0);
});

function mockRpc(body, remaining = () => 2000) {
  const code = `const {createInterface}=require('node:readline');
    const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
    createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line); ${body} });`;
  return new CodexRpc({ cwd: process.cwd(), remaining, executable: process.execPath, args: ["-e", code] });
}

test("turn deadline includes waiting for the start acknowledgement", { timeout: 5000 }, async () => {
  const rpc = mockRpc(`if(m.method==='turn/start') {
    setTimeout(()=>send({id:m.id,result:{turn:{id:'turn'}}}),250);
    setTimeout(()=>{
      send({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{type:'agentMessage',phase:'final_answer',text:'ok'}}});
      send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}});
    },650);
  }`, () => 500);
  try { await assert.rejects(rpc.turn("thread", "fixture"), /No correlated terminal|RPC timeout/); }
  finally { await rpc.close(); }
});

test("correlated completed output survives notifications arriving before the start response", { timeout: 5000 }, async () => {
  const rpc = mockRpc(`if(m.method==='turn/start') {
    send({method:'item/completed',params:{threadId:'foreign',turnId:'turn',item:{type:'agentMessage',phase:'final_answer',text:'wrong'}}});
    send({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{type:'agentMessage',phase:'commentary',text:'working'}}});
    send({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{type:'agentMessage',phase:'final_answer',text:'{"answer":"ok"}'}}});
    send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}});
    send({id:m.id,result:{turn:{id:'turn'}}});
  }`);
  try {
    const result = await rpc.turn("thread", "fixture", {});
    assert.deepEqual(result.value, { answer: "ok" });
    assert.deepEqual(result.phases, ["commentary", "final_answer"]);
  } finally { await rpc.close(); }
});
