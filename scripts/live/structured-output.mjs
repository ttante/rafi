/** Provider-interface experiments only; not production adapters or release certification. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createLiveWorkspace } from "./workspace.mjs";
import { wireSchema } from "../comms/contracts.mjs";
import { CodexRpc, createStructuredSpendLedger, createStructuredRetainedEvidenceDirectory, probeConfig, providerVersions } from "./structured-output-support.mjs";

import { runSupervisedStructuredLive } from "./structured-live-supervisor.mjs";

await runSupervisedStructuredLive("structured-output", async (supervisor) => {
const { deadline, providers, profile, maximumHostDispatches, liveValidation } = supervisor.config;
const spend = createStructuredSpendLedger(5, supervisor.config.requireAuthoritativeCost);
const { workspaceRoot: cwd, evidenceRoot } = createLiveWorkspace("structured-output", { evidenceRoot: supervisor.evidenceRoot });
execFileSync("git", ["init", "-q"], { cwd });
const nonce = randomUUID();
const results = [];
const events = [];
const report = { kind: "live-interface-preflight", profile, node: process.version, startedAt: new Date().toISOString(),
  sourceHashes: Object.fromEntries([import.meta.url, new URL("../comms/contracts.mjs", import.meta.url).href, new URL("./structured-output-support.mjs", import.meta.url).href].map(path =>
    [path, createHash("sha256").update(readFileSync(new URL(path))).digest("hex")])),
  cwd, deadline: new Date(deadline).toISOString(), limits: { turnTimeoutMs: 90_000, maximumHostDispatches,
    maximumSpendUsd: supervisor.config.maximumSpendUsd, claudeSdkMaxTurnsPerQuery: 4,
    costTelemetryRequired: supervisor.config.requireAuthoritativeCost, codexLiveStatus: "enabled" },
  versions: { ...providerVersions(providers, execFileSync, process.env.RAFI_LIVE_CLAUDE_EXECUTABLE),
    ...(providers.includes("claude") ? { sdk: JSON.parse(readFileSync(new URL("../../node_modules/@anthropic-ai/claude-agent-sdk/package.json", import.meta.url))).version } : {}) }, results };
const save = () => { writeFileSync(join(evidenceRoot, "results.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(evidenceRoot, "events.json"), JSON.stringify(events, null, 2)); };
console.log(`Structured-output evidence: ${evidenceRoot}`); save();
const remaining = () => { const ms = Math.min(90_000, deadline - Date.now()); if (ms <= 0) throw new Error("Live deadline expired"); return ms; };
const schema = field => ({ type: "object", properties: { [field]: { type: "string" } }, required: [field], additionalProperties: false });
const checkValue = (value, field, expected) => assert.deepEqual(value, { [field]: expected });
async function scenario(provider, name, fn) {
  const start = performance.now();
  try { const detail = await fn(); results.push({ provider, name, status: "passed", seconds: (performance.now() - start) / 1000, ...detail }); }
  catch (error) { results.push({ provider, name, status: "failed", seconds: (performance.now() - start) / 1000, error: String(error) }); save(); throw error; }
  save(); console.log(`${provider}: ${name} passed`);
}

async function claudeTurn(prompt, outputSchema, resume, interrupt = false) {
  const lease = supervisor.reserveQuery("claude");
  const controller = new AbortController();
  const abort = () => controller.abort();
  supervisor.signal.addEventListener("abort", abort, { once: true });
  const release = supervisor.track(() => { controller.abort(); stream?.close(); });
  const timer = setTimeout(() => controller.abort(), remaining());
  let stream;
  let terminal, interrupted = false, sessionId;
  const messages = [];
  try {
    stream = query({ prompt, options: { cwd, pathToClaudeCodeExecutable: process.env.RAFI_LIVE_CLAUDE_EXECUTABLE ?? "claude",
      model: process.env.RAFI_LIVE_CLAUDE_MODEL ?? "sonnet", settingSources: ["user"], tools: [],
      permissionMode: "default", canUseTool: async () => ({ behavior: "deny", message: "No domain tools in this probe" }),
      maxTurns: 4, maxBudgetUsd: lease.maximumSpendUsd, abortController: controller,
      ...(resume ? { resume } : {}), ...(outputSchema ? { outputFormat: { type: "json_schema", schema: outputSchema } } : {}) } });
    for await (const message of stream) {
      messages.push(message); events.push({ provider: "claude", message });
      sessionId = message.session_id ?? sessionId;
      if (interrupt && !interrupted && message.type === "system" && message.subtype === "init") {
        interrupted = true; controller.abort();
      }
      if (message.type === "result") { terminal = message; lease.record(message.total_cost_usd); }
    }
  } catch (error) { if (!interrupt || !interrupted) throw error; }
  finally { clearTimeout(timer); stream?.close(); lease.close(); release(); supervisor.signal.removeEventListener("abort", abort); save(); }
  assert.ok(messages.every(m => m.type !== "assistant" || m.message.content.every(c => c.type !== "tool_use" || c.name === "StructuredOutput")), "Unexpected domain tool");
  if (interrupt) { assert.ok(interrupted); assert.ok(!terminal || terminal.subtype !== "success"); return { interrupted, sessionId, terminalSubtype: terminal?.subtype ?? "absent" }; }
  assert.equal(terminal?.subtype, "success", JSON.stringify(terminal));
  spend.record("claude", terminal.total_cost_usd);
  return { sessionId, value: terminal.structured_output, text: terminal.result,
    costUsd: terminal.total_cost_usd, numTurns: terminal.num_turns,
    models: [...new Set(messages.flatMap(m => m.type === "assistant" ? [m.message.model] : []))] };
}


for (const provider of providers) {
  try {
    spend.assertProviderIsAuditable(provider);
    if (profile === "contracts") {
      const drafts = {
        "work-report": { kind: "completed", summary: "Already verified", change: "already-satisfied", evidenceIds: ["fixture-result"] },
        "qa-verdict": { kind: "failed", summary: "Fixture check failed", evidenceIds: ["fixture-result"],
          findings: [{ requirementId: "fixture-req", problem: "Expected one, received two", evidenceIds: ["fixture-result"], verification: "Expect one" }] },
        handoff: { kind: "requested", reason: "Context boundary", remainingWork: ["Verify fixture"], evidenceIds: ["fixture-result"] },
      };
      let rpc, thread;
      try {
        if (provider === "codex") {
          rpc = new CodexRpc({ cwd, events, save, remaining }); await rpc.initialize();
          const start = await rpc.request("thread/start", { cwd, approvalPolicy: "never", sandbox: "read-only",
            model: process.env.RAFI_LIVE_CODEX_MODEL ?? null, developerInstructions: "Synthetic contract probe. No domain tools." });
          thread = start.thread.id; report.codexModel = start.model;
        }
        for (const [operation, result] of Object.entries(drafts)) await scenario(provider, `representative-${operation}`, async () => {
          const expected = { version: 1, operation, result, continuity: { summary: "Synthetic fixture only", uncertainties: [] } };
          const prompt = `Synthetic serialization experiment, not actual work or QA. Do not use domain tools. Return this exact value through the configured result format: ${JSON.stringify(expected)}`;
          const response = rpc ? await rpc.turn(thread, prompt, wireSchema(operation, provider)) : await claudeTurn(prompt, wireSchema(operation, provider));
          assert.deepEqual(response.value, expected);
          return response;
        });
      } finally { if (rpc) await rpc.close(); }
      continue;
    }
    if (provider === "claude") {
      let session;
      await scenario(provider, "text-baseline", async () => { const r = await claudeTurn(`Do not use tools. Reply exactly BASELINE_OK.`, undefined); assert.equal(r.text?.trim(), "BASELINE_OK"); return r; });
      await scenario(provider, "structured-result", async () => { const r = await claudeTurn(`Do not use domain tools. Remember secret ${nonce}. Return it in field answer using the configured output format.`, schema("answer")); checkValue(r.value, "answer", nonce); session = r.sessionId; return r; });
      await scenario(provider, "changed-schema-exact-session-resume", async () => { const r = await claudeTurn("Do not use domain tools. Return the secret from the previous turn in field recalled using the new output format.", schema("recalled"), session); assert.equal(r.sessionId, session); checkValue(r.value, "recalled", nonce); return r; });
      await scenario(provider, "abort-without-acceptance", () => claudeTurn("Do not use tools. Produce a long detailed answer.", schema("answer"), session, true));
    } else {
      let rpc = new CodexRpc({ cwd, events, save, remaining }); let thread;
      try {
        await rpc.initialize();
        const start = await rpc.request("thread/start", { cwd, approvalPolicy: "never", sandbox: "read-only", model: process.env.RAFI_LIVE_CODEX_MODEL ?? null,
          config: { sandbox_workspace_write: { network_access: false } }, developerInstructions: "Interface probe. Do not use tools. Obey the requested result schema." });
        thread = start.thread.id; report.codexModel = start.model;
        await scenario(provider, "text-baseline", async () => { const r = await rpc.turn(thread, "Reply exactly BASELINE_OK."); assert.equal(r.text.trim(), "BASELINE_OK"); return r; });
        await scenario(provider, "structured-result", async () => { const r = await rpc.turn(thread, `Remember secret ${nonce}. Return it in answer.`, schema("answer")); checkValue(r.value, "answer", nonce); return r; });
        await scenario(provider, "changed-schema-same-thread", async () => { const r = await rpc.turn(thread, "Return the remembered secret in recalled.", schema("recalled")); checkValue(r.value, "recalled", nonce); return r; });
        await scenario(provider, "interrupted-terminal", () => rpc.turn(thread, "Write a long detailed response.", schema("answer"), true));
      } finally { await rpc.close(); }
      rpc = new CodexRpc({ cwd, events, save, remaining });
      try {
        await rpc.initialize();
        const resumed = await rpc.request("thread/resume", { threadId: thread, cwd, approvalPolicy: "never", sandbox: "read-only" });
        assert.equal(resumed.thread.id, thread);
        await scenario(provider, "resume-after-interruption", async () => { const r = await rpc.turn(thread, "Return the original remembered secret in recalled.", schema("recalled")); checkValue(r.value, "recalled", nonce); return r; });
      } finally { await rpc.close(); }
    }
  } catch (error) { report.failures ??= []; report.failures.push({ provider, error: String(error) }); process.exitCode = 1; save(); }
}
report.finishedAt = new Date().toISOString(); save();

if (process.exitCode) throw new Error("Structured live runner recorded a failure");
});
