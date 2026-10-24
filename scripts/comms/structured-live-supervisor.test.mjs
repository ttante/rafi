import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StructuredLiveRunSupervisor } from "../live/structured-live-supervisor.mjs";

function env(root, elapsed = 60_000) { return { RAFI_LIVE_STRUCTURED: "1", RAFI_LIVE_CREDENTIAL_SCOPE: "fixture",
  RAFI_LIVE_REQUIRE_COST_METER: "1",
  RAFI_LIVE_RETAINED_LOG_DIRECTORY: root, RAFI_LIVE_PROVIDERS: "claude", RAFI_LIVE_DEADLINE: new Date(Date.now() + elapsed).toISOString() }; }

test("live supervisor shares reservations across runners and releases only authoritative unused budget", async () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-live-budget-"));
  try {
    const config = env(root), a = new StructuredLiveRunSupervisor("a", config), b = new StructuredLiveRunSupervisor("b", config);
    await a.execute(async () => {
      const first = a.reserveQuery("claude", 4), second = b.reserveQuery("claude", 4);
      assert.equal(second.maximumSpendUsd, 1);
      assert.throws(() => a.reserveQuery("claude"), /\$5/);
      first.record(0.25); first.close();
      second.record(0.5); second.close();
      const next = b.reserveQuery("claude", 4.25); assert.equal(next.maximumSpendUsd, 4.25); next.record(0); next.close();
    });
    await b.execute(async () => {});
    assert.equal(JSON.parse(readFileSync(a.budgetPath)).spentUnits, 750000);
    assert.equal(JSON.parse(readFileSync(a.reportPath)).status, "passed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("deadline aborts active work, closes its owner, and retains failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-live-deadline-"));
  try {
    const supervisor = new StructuredLiveRunSupervisor("timeout", env(root, 100));
    let closed = 0;
    await assert.rejects(supervisor.execute(async () => {
      supervisor.track(() => { closed++; });
      await new Promise(() => {});
    }), /deadline/);
    assert.equal(closed, 1);
    assert.throws(() => supervisor.reserveQuery("claude"), /deadline/);
    assert.equal(JSON.parse(readFileSync(supervisor.reportPath)).status, "failed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unknown terminal cost stays charged and blocks the next runner", async () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-live-unknown-"));
  try {
    const supervisor = new StructuredLiveRunSupervisor("unknown", env(root));
    await assert.rejects(supervisor.execute(async () => { supervisor.reserveQuery("claude"); }), /Missing authoritative/);
    const report = JSON.parse(readFileSync(supervisor.budgetPath));
    assert.equal(report.spentUnits, 500000); assert.match(report.blocked, /without authoritative/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("strict opt-in rejects missing Codex metering and missing scope fails before evidence", () => {
  const root = join(tmpdir(), `rafi-no-live-effects-${process.pid}-${Date.now()}`);
  assert.throws(() => new StructuredLiveRunSupervisor("codex", { ...env(root), RAFI_LIVE_PROVIDERS: "codex" }), /authoritative spend meter/);
  assert.throws(() => new StructuredLiveRunSupervisor("missing", { ...env(root), RAFI_LIVE_CREDENTIAL_SCOPE: "" }), /CREDENTIAL_SCOPE/);
  assert.equal(existsSync(root), false);
});

test("default live policy permits both providers and retains missing cost as unknown", async () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-live-optional-cost-"));
  try {
    const supervisor = new StructuredLiveRunSupervisor("optional", { ...env(root), RAFI_LIVE_REQUIRE_COST_METER: "0", RAFI_LIVE_PROVIDERS: "claude,codex" });
    await supervisor.execute(async () => {
      const codex = supervisor.reserveQuery("codex"), claude = supervisor.reserveQuery("claude");
      claude.record(0.25); claude.close(); codex.close();
      const next = supervisor.reserveQuery("codex"); next.close();
    });
    const report = JSON.parse(readFileSync(supervisor.reportPath));
    assert.equal(report.status, "passed");
    assert.equal(report.maximumSpendUsd, null);
    assert.equal(report.results.filter(row => row.status === "unmetered" && row.authoritativeCostUsd === null).length, 2);
    const ledger = JSON.parse(readFileSync(supervisor.budgetPath));
    assert.equal(ledger.spentUnits, 250000);
    assert.equal(ledger.unmeteredQueries, 2);
    assert.equal(ledger.blocked, undefined);
    assert.equal(Object.keys(ledger.reservations).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CLI children can use Codex when cost metering is optional", async () => {
  const { inheritedStructuredLiveBudget } = await import("../../packages/ai-foreman/src/structuredLiveBudget.ts");
  const root = mkdtempSync(join(tmpdir(), "rafi-live-codex-child-"));
  try {
    const config = { ...env(root), RAFI_LIVE_REQUIRE_COST_METER: "0", RAFI_LIVE_PROVIDERS: "claude,codex" };
    const supervisor = new StructuredLiveRunSupervisor("parent", config);
    await supervisor.execute(async () => {
      const child = inheritedStructuredLiveBudget("codex", { ...config, RAFI_STRUCTURED_LIVE_RUNNER: "parent", RAFI_STRUCTURED_LIVE_BUDGET_PATH: supervisor.budgetPath });
      const lease = child.reserveQuery("codex"); lease.close();
    });
    assert.equal(JSON.parse(readFileSync(supervisor.budgetPath)).unmeteredQueries, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("strict CLI children share reservations and reject unavailable Codex metering", async () => {
  const { execFileSync } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  const { resolve } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "rafi-live-child-"));
  try {
    const config = env(root), supervisor = new StructuredLiveRunSupervisor("parent", config);
    await supervisor.execute(async () => {
      const held = supervisor.reserveQuery("claude", 4);
      const moduleUrl = pathToFileURL(resolve("packages/ai-foreman/src/structuredLiveBudget.ts")).href;
      const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
        import assert from 'node:assert/strict';
        const { inheritedStructuredLiveBudget } = await import(${JSON.stringify(moduleUrl)});
        assert.throws(() => inheritedStructuredLiveBudget('codex'), /supervision|spend meter/);
        const lease = inheritedStructuredLiveBudget('claude').reserveQuery('claude');
        assert.equal(lease.maximumSpendUsd, 0.5); lease.record(0.125); lease.close();
        console.log('child-settled');
      `], { env: { ...process.env, ...config, RAFI_STRUCTURED_LIVE_RUNNER: "parent", RAFI_STRUCTURED_LIVE_BUDGET_PATH: supervisor.budgetPath }, encoding: "utf8" });
      assert.match(output, /child-settled/);
      held.record(0); held.close();
    });
    assert.equal(JSON.parse(readFileSync(supervisor.budgetPath)).spentUnits, 125000);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("SIGTERM drains owned work and retains a final failure report", async () => {
  const { spawn } = await import("node:child_process");
  const { resolve } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const root = mkdtempSync(join(tmpdir(), "rafi-live-signal-"));
  let child;
  try {
    const moduleUrl = pathToFileURL(resolve("scripts/live/structured-live-supervisor.mjs")).href;
    child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const { runSupervisedStructuredLive } = await import(${JSON.stringify(moduleUrl)});
      await runSupervisedStructuredLive('signal', async supervisor => {
        supervisor.track(async () => writeFileSync(join(supervisor.evidenceRoot, 'closed.txt'), 'closed'));
        console.log(JSON.stringify({ root: supervisor.evidenceRoot }));
        await new Promise(() => {});
      });
    `], { env: { ...process.env, ...env(root) }, stdio: ["ignore", "pipe", "pipe"] });
    let errorText = ""; child.stderr.on("data", chunk => { errorText += chunk; });
    const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Signal fixture did not start")), 5000);
      child.stdout.once("data", chunk => { clearTimeout(timer); resolve(JSON.parse(String(chunk)).root); });
      child.once("error", error => { clearTimeout(timer); reject(error); });
    });
    child.kill("SIGTERM"); const result = await closed;
    assert.notEqual(result.code, 0, errorText);
    assert.equal(readFileSync(join(ready, "closed.txt"), "utf8"), "closed");
    const report = JSON.parse(readFileSync(join(ready, "supervisor.json")));
    assert.equal(report.status, "failed"); assert.match(report.error, /SIGTERM/);
  } finally { if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); rmSync(root, { recursive: true, force: true }); }
});

test("package-declared live provider tests reject missing authorization before evidence or provider creation", async () => {
  const { spawnSync } = await import("node:child_process");
  const { randomUUID } = await import("node:crypto");
  const root = join(tmpdir(), `rafi-provider-smoke-denied-${randomUUID()}`);
  const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "packages/ai-foreman/test/providerSmoke.test.ts"], {
    cwd: new URL("../../", import.meta.url), encoding: "utf8", timeout: 10000,
    env: { ...process.env, NODE_TEST_CONTEXT: undefined, RAFI_LIVE_PROVIDER_SESSIONS: "1", RAFI_LIVE_STRUCTURED: "0",
      RAFI_LIVE_PROVIDERS: "claude", RAFI_LIVE_CREDENTIAL_SCOPE: "", RAFI_LIVE_RETAINED_LOG_DIRECTORY: root },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /Explicit live-provider authorization required/);
  assert.equal(existsSync(root), false);
});
