import { CodexAdapter } from "../src/adapters/codex.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { boundedJson, createProviderWireContract, outputContract, jsonOutputContract, projectCodexSchema, registerProviderWireContract, validateStructuredCandidate } from "rafi-spec";
import { CodexTurnCollector, structuredReceipt } from "../src/adapters/structured.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { AsyncQueue } from "../src/util/asyncQueue.js";
import type { BuilderAdapterOptions } from "../src/adapters/types.js";

const contract = outputContract("transport-fixture", z.strictObject({ version: z.literal(1), value: z.string().max(20) }));
const identity = { dispatchId: "dispatch-1", sessionId: "session-1", nativeTurnId: "turn-1" };
function registerTestWire(canonical: import("rafi-spec").OutputContract) {
  for (const provider of ["claude", "codex"] as const) registerProviderWireContract(createProviderWireContract({
    canonical, provider, profile: `${provider}-${canonical.operation}-test-v1`, variant: "default", wireVersion: 1,
    wireSchema: canonical.jsonSchema, maximumSchemaBytes: 10_000, maximumResponseBytes: 10_000,
    normalizerId: "identity", normalizerVersion: 1, normalize: value => value,
    guidanceId: `${canonical.operation}-test-v1`, guidance: () => "Return the selected native JSON value only.",
  }));
}
registerTestWire(contract);
test("native receipt accepts the contract and never falls back to prose", () => {
  const receipt = structuredReceipt(contract, "claude", { version: 1, value: "ok" }, identity, "decoded-json");
  assert.deepEqual(validateStructuredCandidate(contract, receipt), { version: 1, value: "ok" });
  for (const candidate of [undefined, { version: 2, value: "ok" }, { version: 1, value: "ok", authority: true }]) {
    const rejected = structuredReceipt(contract, "claude", candidate, identity, "decoded-json");
    assert.throws(() => validateStructuredCandidate(contract, rejected));
    if (candidate !== undefined && rejected.state === "rejected") assert.deepEqual(rejected.observedValue?.value, candidate);
  }
  assert.throws(() => validateStructuredCandidate(outputContract("other", contract.schema), receipt), /mismatch/);
});
test("native JSON rejects duplicates, fences, deep nesting, cycles and non-JSON SDK data", () => {
  for (const raw of ['{"version":1,"version":1,"value":"ok"}', '```json\n{}\n```', '['.repeat(65) + ']'.repeat(65)]) assert.throws(() => boundedJson(raw, "json-text"));
  const cycle: unknown[] = []; cycle.push(cycle);
  for (const raw of [cycle, { a: undefined }, { a: NaN }, new Date()]) assert.throws(() => boundedJson(raw, "decoded-json"));
});
test("Codex projection proves disjointness for each union", () => {
  const json = outputContract("union", z.strictObject({ result: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("done") }), z.strictObject({ status: z.literal("blocked") }),
  ]) })).jsonSchema;
  assert.match(JSON.stringify(projectCodexSchema(json)), /anyOf/);
  assert.throws(() => projectCodexSchema({ oneOf: [{ type: "object" }, { type: "object" }] }), /overlapping/);
});
test("Codex optional absence projection preserves null semantics, required fields and unknown-field rejection", () => {
  const shape = outputContract("optional", z.strictObject({ required: z.string(), optional: z.string().optional(), nullable: z.string().nullable().optional(), nested: z.strictObject({ flag: z.boolean().optional() }).optional() }));
  const receipt = (value: unknown) => structuredReceipt(shape, "codex", JSON.stringify(value), identity, "json-text");
  assert.deepEqual(validateStructuredCandidate(shape, receipt({ required: "yes", optional: null, nullable: null, nested: { flag: null } })), { required: "yes", nullable: null, nested: {} });
  assert.throws(() => validateStructuredCandidate(shape, receipt({ required: null, optional: null, nullable: null, nested: null })));
  assert.throws(() => validateStructuredCandidate(shape, receipt({ required: "yes", optional: null, nullable: null, nested: null, unexpected: null })));
  assert.throws(() => validateStructuredCandidate(shape, receipt({ required: "yes" })), /wire schema/);
});

test("Codex projected maps round-trip inside nullable unions and reject duplicate keys", () => {
  const shape = outputContract("map-fixture", z.strictObject({ filters: z.record(z.string().min(1), z.string()).nullable() }));
  const receipt = (value: unknown) => structuredReceipt(shape, "codex", JSON.stringify(value), identity, "json-text");
  assert.deepEqual(validateStructuredCandidate(shape, receipt({ filters: [{ key: "team", value: "alpha" }, { key: "scope", value: "data" }] })), { filters: { team: "alpha", scope: "data" } });
  assert.deepEqual(validateStructuredCandidate(shape, receipt({ filters: null })), { filters: null });
  for (const filters of [[{ key: "__proto__", value: "data" }], [{ key: "same", value: "a" }, { key: "same", value: "b" }], { team: "alpha" }, [{ key: "", value: "a" }]]) {
    assert.throws(() => validateStructuredCandidate(shape, receipt({ filters })));
  }
});

test("Codex oneOf projection accepts disjoint enum discriminators but refuses overlap", () => {
  const branch = (values: string[]) => ({ type: "object", additionalProperties: false, required: ["kind"], properties: { kind: { enum: values } } });
  assert.ok((projectCodexSchema({ oneOf: [branch(["a", "b"]), branch(["c"])] }) as any).anyOf);
  assert.throws(() => projectCodexSchema({ oneOf: [branch(["a", "b"]), branch(["b"])] }), /overlapping/);
});
test("Codex buffers early final/terminal, ignores foreign turns and commentary, deduplicates native items", async () => {
  const collector = new CodexTurnCollector("thread", true);
  const item = { type: "agentMessage", id: "final", phase: "final_answer", text: '{"version":1,"value":"ok"}' };
  for (const turnId of ["foreign", "ours", "ours"]) collector.ingest("item/completed", { threadId: "thread", turnId, item });
  collector.ingest("item/completed", { threadId: "thread", turnId: "ours", item: { ...item, id: "comment", phase: "commentary", text: "progress" } });
  collector.ingest("turn/completed", { threadId: "thread", turn: { id: "foreign", status: "failed" } });
  collector.ingest("turn/completed", { threadId: "thread", turn: { id: "ours", status: "completed" } });
  collector.bind("ours");
  assert.equal((await collector.completion).status, "completed");
  assert.deepEqual(collector.final(), { text: item.text, itemId: "final" });
});
test("Codex rejects conflicting or distinct finals, preserves interrupted status", async () => {
  for (const repeatedId of [true, false]) {
    const collector = new CodexTurnCollector("thread", true); collector.bind("turn");
    for (const [i, text] of ["first", "second"].entries()) collector.ingest("item/completed", { threadId: "thread", turnId: "turn", item: { type: "agentMessage", phase: "final_answer", id: repeatedId ? "same" : String(i), text } });
    collector.ingest("turn/completed", { threadId: "thread", turn: { id: "turn", status: "interrupted" } });
    assert.equal((await collector.completion).status, "interrupted");
    assert.throws(() => collector.final());
  }
});

test("Claude production adapter changes schema by closing/resuming exact session; missing structured output fails", async () => {
  const configs: Array<Record<string, any>> = [];
  const producers: Promise<void>[] = [];
  const Constructor = ClaudeAdapter as unknown as new (opts: BuilderAdapterOptions, query: (input: any) => any) => ClaudeAdapter;
  const adapter = new Constructor({ cwd: "/tmp", permission: async () => ({ behavior: "deny", message: "no tools" }) }, config => {
    configs.push(config.options);
    const stream = new AsyncQueue<unknown>();
    producers.push((async () => {
      for await (const input of config.prompt) {
        stream.push({ type: "system", subtype: "init", session_id: "exact-session", cwd: "/tmp" });
        const content = input.message.content;
        if (content.startsWith("first\n\n<!-- rafi:selected-provider-wire")) {
          const hook = config.options.hooks.PreToolUse[0].hooks[0];
          const invalid = await hook({ hook_event_name: "PreToolUse", tool_name: "StructuredOutput", tool_input: { value: "ok" }, tool_use_id: "invalid-native", cwd: "/tmp" });
          assert.equal(invalid.hookSpecificOutput.permissionDecision, "deny");
          assert.match(invalid.hookSpecificOutput.permissionDecisionReason, /version/);
          assert.doesNotMatch(invalid.hookSpecificOutput.permissionDecisionReason, /mutation|shell commands/);
          assert.deepEqual(await hook({ hook_event_name: "PreToolUse", tool_name: "StructuredOutput", tool_input: { version: 1, value: "ok" }, tool_use_id: "valid-native", cwd: "/tmp" }), {});
          assert.equal((await config.options.canUseTool("StructuredOutput", { version: 1, value: "ok" })).behavior, "allow");
          assert.equal((await config.options.canUseTool("StructuredOutput", { value: "ok" })).behavior, "deny");
        }

        stream.push({ type: "result", subtype: "success", uuid: `result-${configs.length}`, session_id: "exact-session", result: "display is not JSON", is_error: false, num_turns: 1, total_cost_usd: 0,
          ...(content.startsWith("missing\n\n<!-- rafi:selected-provider-wire") ? {} : { structured_output: content.startsWith("second\n\n<!-- rafi:selected-provider-wire") ? { answer: 2 } : { version: 1, value: "ok" } }) });
      }
    })());
    return { [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](), close: () => stream.close(), interrupt: async () => stream.close() };
  });
  try {
    const first = await adapter.sendTurn("first", { output: contract, responseOnly: true });
    assert.equal(first.isError, false);
    assert.deepEqual(validateStructuredCandidate(contract, first.structured), { version: 1, value: "ok" });
    const other = outputContract("other", z.strictObject({ answer: z.literal(2) }));
    registerTestWire(other);
    const second = await adapter.sendTurn("second", { output: other, responseOnly: true });
    assert.equal(second.isError, false);
    assert.equal(configs.at(-1)?.resume, "exact-session");
    assert.deepEqual(configs.at(-1)?.outputFormat.schema, other.jsonSchema);
    const missing = await adapter.sendTurn("missing", { output: other });
    assert.equal(missing.isError, true);
    assert.equal(missing.structured?.state, "rejected");
    assert.equal(adapter.sessionId(), "exact-session");
  } finally { await adapter.close(); await Promise.all(producers); }
});

test("Claude validates the selected provider wire before canonical normalization", async () => {
  const configs: Array<Record<string, any>> = [];
  const producers: Promise<void>[] = [];
  const canonical = outputContract("flat-wire", z.strictObject({ version: z.literal(1), value: z.string().max(20) }));
  const wireSchema = z.toJSONSchema(z.strictObject({ answer: z.string().max(20) }), { target: "draft-7", io: "input" }) as Record<string, unknown>;
  const wire = createProviderWireContract({
    canonical, provider: "claude", profile: "claude-flat-wire-v1", variant: "default", wireVersion: 1, wireSchema,
    maximumSchemaBytes: 10_000, maximumResponseBytes: 10_000, normalizerId: "flat-wire-v1", normalizerVersion: 1,
    normalize: (value: unknown) => ({ version: 1, value: (value as { answer: string }).answer }),
    guidanceId: "flat-wire-v1", guidance: () => "Return { answer } only.",
  });
  const Constructor = ClaudeAdapter as unknown as new (opts: BuilderAdapterOptions, query: (input: any) => any) => ClaudeAdapter;
  const adapter = new Constructor({ cwd: "/tmp", permission: async () => ({ behavior: "deny", message: "no tools" }) }, config => {
    configs.push(config.options);
    const stream = new AsyncQueue<unknown>();
    producers.push((async () => {
      for await (const input of config.prompt) {
        stream.push({ type: "system", subtype: "init", session_id: "flat-wire-session", cwd: "/tmp" });
        const hook = config.options.hooks.PreToolUse[0].hooks[0];
        const invalid = await hook({ hook_event_name: "PreToolUse", tool_name: "StructuredOutput", tool_input: { version: 1, value: "wrong-layer" }, tool_use_id: "invalid-wire", cwd: "/tmp" });
        assert.equal(invalid.hookSpecificOutput.permissionDecision, "deny");
        assert.match(invalid.hookSpecificOutput.permissionDecisionReason, /selected claude-flat-wire-v1 wire contract/);
        assert.deepEqual(await hook({ hook_event_name: "PreToolUse", tool_name: "StructuredOutput", tool_input: { answer: "ok" }, tool_use_id: "valid-wire", cwd: "/tmp" }), {});
        stream.push({ type: "result", subtype: "success", uuid: "flat-wire-result", session_id: "flat-wire-session", result: "display", is_error: false, num_turns: 1, total_cost_usd: 0, structured_output: { answer: "ok" } });
      }
    })());
    return { [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](), close: () => stream.close(), interrupt: async () => stream.close() };
  });
  try {
    const turn = await adapter.sendTurn("flat", { output: canonical, wireContract: wire, responseOnly: true });
    assert.equal(turn.isError, false);
    assert.deepEqual(validateStructuredCandidate(canonical, turn.structured, wire), { version: 1, value: "ok" });
    assert.deepEqual(configs.at(-1)?.outputFormat.schema, wireSchema);
  } finally { await adapter.close(); await Promise.all(producers); }
});

test("Codex omits unsupported wire uniqueness while canonical acceptance rejects duplicates", () => {
  const contract = jsonOutputContract("unique-fixture", { type: "object", additionalProperties: false, required: ["ids"], properties: { ids: { type: "array", uniqueItems: true, items: { type: "string" } } } });
  assert.doesNotMatch(JSON.stringify(projectCodexSchema(contract.jsonSchema)), /uniqueItems/);
  const candidate = (ids: string[]) => structuredReceipt(contract, "codex", JSON.stringify({ ids }), identity, "json-text");
  assert.deepEqual(validateStructuredCandidate(contract, candidate(["one", "two"])), { ids: ["one", "two"] });
  assert.throws(() => validateStructuredCandidate(contract, candidate(["one", "one"])));
});


test("Codex native idle supervision ignores foreign progress and never redispatches", async () => {
  const adapter = new CodexAdapter({ cwd: "/tmp", providerIdleTimeoutMs: 30, turnDeadlineMs: 1000, permission: async () => ({ behavior: "deny", message: "fixture" }) });
  let dispatches = 0;
  const transport = adapter as unknown as { ensureConnection(): Promise<void>; request(method: string): Promise<unknown>; handle(message: unknown): void };
  transport.ensureConnection = async () => {};
  transport.request = async method => {
    if (method === "thread/start") return { thread: { id: "idle-thread", cwd: "/tmp" } };
    if (method === "turn/start") { dispatches++; return { turn: { id: "idle-turn" } }; }
    return {};
  };
  const noise = setInterval(() => transport.handle({ method: "item/agentMessage/delta", params: { threadId: "idle-thread", turnId: "foreign-turn", delta: "unrelated" } }), 5);
  try {
    const turn = await adapter.sendTurn("wait for native result", { output: contract, dispatchId: "idle-dispatch" });
    assert.equal(turn.isError, true); assert.equal(turn.failure?.dispatchState, "unknown");
    assert.match(turn.text, /idle deadline/); assert.equal(dispatches, 1);
  } finally { clearInterval(noise); await adapter.close(); }
});

test("Codex progress belongs to its exact native turn and cannot extend a completed turn", async () => {
  let progress = 0;
  const collector = new CodexTurnCollector("thread", true, () => progress++);
  collector.bind("turn");
  collector.ingest("item/agentMessage/delta", { threadId: "other", turnId: "turn", delta: "foreign" });
  collector.ingest("item/agentMessage/delta", { threadId: "thread", turnId: "other", delta: "foreign" });
  assert.equal(progress, 1);
  collector.ingest("item/agentMessage/delta", { threadId: "thread", turnId: "turn", delta: "current" });
  assert.equal(progress, 2);
  collector.ingest("turn/completed", { threadId: "thread", turn: { id: "turn", status: "completed" } });
  await collector.completion;
  collector.ingest("item/agentMessage/delta", { threadId: "thread", turnId: "turn", delta: "late" });
  assert.equal(progress, 3);
});
