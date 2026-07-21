/**
 * Phase 5 — adapter option mapping. Pins that systemPromptAppend and skills wire
 * onto the correct SDK options (Claude) and that Codex prepends system text to
 * turn instructions. No live SDK calls — tests operate on pure functions / methods.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildClaudeQueryOptions, requireClaudeSDK } from "../src/adapters/claude.js";
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

test("buildClaudeQueryOptions includes skills and settingSources when skills provided", () => {
  const opts = buildClaudeQueryOptions({ ...BASE_OPTS, skills: ["tdd", "grill-me"] });
  assert.deepEqual(opts.skills, ["tdd", "grill-me"]);
  assert.deepEqual(opts.settingSources, ["project"]);
});

test("buildClaudeQueryOptions omits systemPrompt when systemPromptAppend is absent", () => {
  const opts = buildClaudeQueryOptions(BASE_OPTS);
  assert.equal(opts.systemPrompt, undefined);
});

test("buildClaudeQueryOptions omits skills/settingSources when skills is absent", () => {
  const opts = buildClaudeQueryOptions(BASE_OPTS);
  assert.equal(opts.skills, undefined);
  assert.equal(opts.settingSources, undefined);
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
