/**
 * Phase 5 — adapter option mapping. Pins that systemPromptAppend and skills wire
 * onto the correct SDK options (Claude) and that Codex prepends system text to
 * turn instructions. No live SDK calls — tests operate on pure functions / methods.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildClaudeQueryOptions, claudeApiRetryEvent, mergeClaudeProviderSessionUsage, permissionDecisionToClaudeResult, requireClaudeSDK } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import type { BuilderAdapterOptions } from "../src/adapters/types.js";

const BASE_OPTS: BuilderAdapterOptions = {
  cwd: "/tmp/test",
  permission: async () => ({ behavior: "allow" as const }),
};

// --- Claude adapter option mapping ---

test("buildClaudeQueryOptions maps systemPromptAppend to systemPrompt.append", () => {
  const opts = buildClaudeQueryOptions({ ...BASE_OPTS, systemPromptAppend: "## My Rules\n" });
  const sp = opts.systemPrompt as { type: string; preset: string; append: string };
  assert.equal(sp.type, "preset");
  assert.equal(sp.preset, "claude_code");
  assert.equal(sp.append, "## My Rules\n");
});

test("buildClaudeQueryOptions includes skills and all CLI setting sources", () => {
  const opts = buildClaudeQueryOptions({ ...BASE_OPTS, runtimeExecutable: "/opt/company/bin/claude", skills: ["tdd", "grill-me"] });
  assert.deepEqual(opts.skills, ["tdd", "grill-me"]);
  assert.deepEqual(opts.settingSources, ["user", "project", "local"]);
  assert.equal(opts.pathToClaudeCodeExecutable, "/opt/company/bin/claude");
  const env = opts.env as NodeJS.ProcessEnv;
  assert.equal(env.PATH, process.env.PATH);
  assert.equal(env.HTTPS_PROXY, process.env.HTTPS_PROXY);
});

test("buildClaudeQueryOptions omits systemPrompt when systemPromptAppend is absent", () => {
  const opts = buildClaudeQueryOptions(BASE_OPTS);
  assert.equal(opts.systemPrompt, undefined);
});

test("buildClaudeQueryOptions omits skills but retains CLI-equivalent setting sources", () => {
  const opts = buildClaudeQueryOptions(BASE_OPTS);
  assert.equal(opts.skills, undefined);
  assert.deepEqual(opts.settingSources, ["user", "project", "local"]);
});

test("buildClaudeQueryOptions forwards cwd, model, effort, and resumeSessionId unchanged", () => {
  const opts = buildClaudeQueryOptions({
    ...BASE_OPTS,
    model: "claude-opus-4-8",
    effort: "high",
    resumeSessionId: "sess-abc",
  });
  assert.equal(opts.cwd, "/tmp/test");
  assert.equal(opts.model, "claude-opus-4-8");
  assert.equal(opts.effort, "high");
  assert.equal(opts.resume, "sess-abc");
});

test("Claude cumulative usage replaces absolute SDK totals and never fabricates zero usage", () => {
  const empty = mergeClaudeProviderSessionUsage(
    { observedAt: new Date(0).toISOString(), source: "provider" },
    { type: "result", usage: {}, total_cost_usd: undefined },
    "2026-01-01T00:00:00.000Z",
  );
  assert.deepEqual(empty.sample, { observedAt: "2026-01-01T00:00:00.000Z", source: "provider" });

  const first = mergeClaudeProviderSessionUsage(empty.sample, {
    usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 5 },
    total_cost_usd: 0.25,
  }, "2026-01-01T00:00:01.000Z");
  assert.deepEqual(first.sample, {
    inputTokens: 60, outputTokens: 5, totalTokens: 65, authoritativeCostUsd: 0.25,
    observedAt: "2026-01-01T00:00:01.000Z", source: "provider",
  });

  const second = mergeClaudeProviderSessionUsage(first.sample, {
    usage: { input_tokens: 12, cache_creation_input_tokens: 20, cache_read_input_tokens: 40, output_tokens: 8 },
    total_cost_usd: 0.4,
  }, "2026-01-01T00:00:02.000Z");
  assert.equal(second.sample.totalTokens, 80);
  assert.equal(second.sample.authoritativeCostUsd, 0.4);
});

test("permissionDecisionToClaudeResult preserves updatedInput and interrupt", () => {
  assert.deepEqual(permissionDecisionToClaudeResult({
    behavior: "allow",
    updatedInput: { questions: [], answers: { "Continue?": "Yes" } },
  }, "toolu_123"), {
    behavior: "allow",
    updatedInput: { questions: [], answers: { "Continue?": "Yes" } },
    updatedPermissions: undefined,
    toolUseID: "toolu_123",
  });

  assert.deepEqual(permissionDecisionToClaudeResult({
    behavior: "deny",
    message: "cancelled",
    interrupt: true,
  }, "toolu_456"), {
    behavior: "deny",
    message: "cancelled",
    interrupt: true,
    toolUseID: "toolu_456",
  });
});

test("Claude API retry messages normalize into immediate retry events", () => {
  assert.deepEqual(claudeApiRetryEvent({
    error: "Connection closed mid-response",
    attempt: 2,
    max_retries: 4,
    retry_delay_ms: 1500,
  }), {
    kind: "retry",
    provider: "claude",
    reason: "Connection closed mid-response",
    attempt: 2,
    maximum: 4,
    delayMs: 1500,
    managedBy: "provider",
  });
});

// --- Codex adapter instruction building ---

test("CodexAdapter.buildInstruction prepends systemPromptAppend to the turn text", () => {
  const adapter = new CodexAdapter({ ...BASE_OPTS, systemPromptAppend: "## Rules\n- Rule 1\n" });
  const result = adapter.buildInstruction("Do the thing.");
  assert.ok(result.startsWith("## Rules\n- Rule 1\n"), "system text must come first");
  assert.ok(result.includes("Do the thing."), "original instruction must be present");
});

test("CodexAdapter.buildInstruction flattens requested bundled skills", () => {
  const adapter = new CodexAdapter({ ...BASE_OPTS, skills: ["grill-me"] });
  const result = adapter.buildInstruction("Plan the work.");
  assert.match(result, /# Preloaded Skills/);
  assert.match(result, /## grill-me/);
  assert.match(result, /Interview me relentlessly/);
  assert.ok(result.endsWith("Plan the work."), "original instruction must remain last");
});

test("CodexAdapter.buildInstruction returns instruction unchanged when no systemPromptAppend", () => {
  const adapter = new CodexAdapter(BASE_OPTS);
  assert.equal(adapter.buildInstruction("Do the thing."), "Do the thing.");
});

// --- requireClaudeSDK ---

test("requireClaudeSDK resolves to a module with a query function", async () => {
  const sdk = await requireClaudeSDK();
  assert.equal(typeof sdk.query, "function");
});
