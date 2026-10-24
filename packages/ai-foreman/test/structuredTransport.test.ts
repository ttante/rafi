import { CodexAdapter } from "../src/adapters/codex.js";
import { withSealedDispatch } from "../src/structuredDispatchAuthority.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { boundedJson, createProviderWireContract, decodeCodexOptionalProperties, outputContract, jsonOutputContract, projectCodexSchema, renderProviderWireInstruction, selectedDispatchTupleV2, structuredDigest, validateStructuredCandidate as validateCandidate } from "rafi-spec";
import { CodexTurnCollector, structuredReceipt as createReceipt } from "../src/adapters/structured.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { AsyncQueue } from "../src/util/asyncQueue.js";
import type { BuilderAdapterOptions } from "../src/adapters/types.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowDb } from "../src/workflowDb.js";
import { sealedDispatchRecord } from "../src/structuredDispatchRecord.js";

const contract = outputContract("transport-fixture", z.strictObject({ version: z.literal(1), value: z.string().max(20) }));
const identity = { dispatchId: "dispatch-1", sessionId: "session-1", nativeTurnId: "turn-1" };
const fixtureReceipts = new WeakMap<object, { descriptor: import("rafi-spec").ProviderWireContract; tuple: import("rafi-spec").SelectedDispatchTupleV2 }>();
function testWire(canonical: import("rafi-spec").OutputContract, provider: "claude" | "codex") {
  return createProviderWireContract({
    canonical, provider, profile: `${provider}-${canonical.operation}-test-v1`, variant: "default", wireVersion: 1,
    wireSchema: provider === "codex" ? projectCodexSchema(canonical.jsonSchema) as Record<string, unknown> : canonical.jsonSchema, maximumSchemaBytes: 10_000, maximumResponseBytes: 10_000,
    normalizerId: provider === "codex" ? "codex-optional-properties" : "identity", normalizerVersion: 1, normalize: value => provider === "codex" ? decodeCodexOptionalProperties(canonical.jsonSchema, value) : value,
    guidanceId: `${canonical.operation}-test-v1`, guidance: () => "Return the selected native JSON value only.",
  });
}
function structuredReceipt(canonical: import("rafi-spec").OutputContract, provider: "claude" | "codex", value: unknown, receiptIdentity: typeof identity, representation: "json-text" | "decoded-json") {
  const descriptor = testWire(canonical, provider);
  const tuple = selectedDispatchTupleV2({ operation: canonical.operation, schemaVersion: canonical.schemaVersion, schemaDigest: canonical.schemaDigest,
    provider, profile: descriptor.profile, variant: descriptor.variant, descriptorDigest: descriptor.descriptorDigest,
    wireSchemaDigest: descriptor.wireSchemaDigest, guidanceDigest: descriptor.guidanceDigest, normalizerId: descriptor.normalizerId,
    normalizerVersion: descriptor.normalizerVersion, maximumSchemaBytes: descriptor.maximumSchemaBytes, maximumResponseBytes: descriptor.maximumResponseBytes,
    maximumPageBytes: descriptor.maximumPageBytes ?? null, instructionDigest: structuredDigest(renderProviderWireInstruction("fixture", descriptor)),
    actionId: receiptIdentity.dispatchId, dispatchId: receiptIdentity.dispatchId, sessionId: receiptIdentity.sessionId, generation: 0 });
  const receipt = createReceipt(canonical, provider, value, receiptIdentity, representation, descriptor, tuple);
  fixtureReceipts.set(receipt, { descriptor, tuple });
  return receipt;
}
function validateStructuredCandidate<T>(canonical: import("rafi-spec").OutputContract<T>, receipt: import("rafi-spec").StructuredResponse | undefined, descriptor?: import("rafi-spec").ProviderWireContract<T>, tuple?: import("rafi-spec").SelectedDispatchTupleV2): T {
  const fixture = receipt && fixtureReceipts.get(receipt);
  return validateCandidate(canonical, receipt, descriptor ?? fixture?.descriptor as import("rafi-spec").ProviderWireContract<T>, tuple ?? fixture?.tuple as import("rafi-spec").SelectedDispatchTupleV2);
}
function transportPolicy(canonical: import("rafi-spec").OutputContract, provider: "claude" | "codex", dispatchId: string, sessionId: string, wireContract = testWire(canonical, provider)) {
  return { output: canonical, wireContract, renderedWireContractDigest: wireContract.descriptorDigest, responseOnly: true, dispatchId, selectedDispatch: selectedDispatchTupleV2({
    operation: canonical.operation, schemaVersion: canonical.schemaVersion, schemaDigest: canonical.schemaDigest, provider,
    profile: wireContract.profile, variant: wireContract.variant, descriptorDigest: wireContract.descriptorDigest,
    wireSchemaDigest: wireContract.wireSchemaDigest, guidanceDigest: wireContract.guidanceDigest, normalizerId: wireContract.normalizerId,
    normalizerVersion: wireContract.normalizerVersion, maximumSchemaBytes: wireContract.maximumSchemaBytes, maximumResponseBytes: wireContract.maximumResponseBytes,
    maximumPageBytes: wireContract.maximumPageBytes ?? null, instructionDigest: structuredDigest(renderProviderWireInstruction("fixture", wireContract)),
    actionId: dispatchId, dispatchId, sessionId, generation: 0 }) };
}
async function sendTransport(adapter: import("../src/adapters/types.js").BuilderAdapter, text: string, policy: ReturnType<typeof transportPolicy>) {
  const prepared = await adapter.prepareSession!();
  assert.equal(prepared.sessionId, policy.selectedDispatch.sessionId);
  const instruction = renderProviderWireInstruction(text, policy.wireContract);
  const { digest, protocolVersion, ...fields } = policy.selectedDispatch;
  policy.selectedDispatch = selectedDispatchTupleV2({ ...fields, instructionDigest: structuredDigest(instruction) });
  const root = mkdtempSync(join(tmpdir(), "native-transport-"));
  const db = new WorkflowDb(root), tuple = policy.selectedDispatch;
  try {
    db.ensureRun("transport");
    db.planOperation({runId:"transport",idempotencyKey:tuple.dispatchId,kind:"provider-dispatch",intent:{protocolVersion:2,state:"preparing"}});
    db.sealPlannedOperationIntent(tuple.dispatchId,{protocolVersion:2,tuple,sealedDispatch:sealedDispatchRecord(tuple),sessionRef:prepared});
    db.updateOperation(tuple.dispatchId,"in_progress");
    return await withSealedDispatch(root, tuple, dispatchCapability => adapter.sendTurn(instruction, { ...policy, dispatchCapability }), prepared);
  } finally { db.close(); rmSync(root, {recursive:true,force:true}); }
}
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
    stream.push({type:"system",subtype:"init",session_id: configs.length === 1 ? "exact-session" : "exact-session",cwd:"/tmp"});
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
    return { initializationResult: async () => ({}), [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](), close: () => stream.close(), interrupt: async () => stream.close() };
  });
  try {
    const firstPolicy = transportPolicy(contract, "claude", "first", "exact-session");
    const first = await sendTransport(adapter, "first", firstPolicy);
    assert.equal(first.isError, false);
    assert.deepEqual(validateStructuredCandidate(contract, first.structured, firstPolicy.wireContract, firstPolicy.selectedDispatch), { version: 1, value: "ok" });
    const other = outputContract("other", z.strictObject({ answer: z.literal(2) }));
    const secondPolicy = transportPolicy(other, "claude", "second", "exact-session");
    const second = await sendTransport(adapter, "second", secondPolicy);
    assert.equal(second.isError, false);
    assert.equal(configs.at(-1)?.resume, "exact-session");
    assert.deepEqual(configs.at(-1)?.outputFormat.schema, other.jsonSchema);
    const missing = await sendTransport(adapter, "missing", transportPolicy(other, "claude", "missing", "exact-session"));
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
    stream.push({type:"system",subtype:"init",session_id:"flat-wire-session",cwd:"/tmp"});
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
    return { initializationResult: async () => ({}), [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](), close: () => stream.close(), interrupt: async () => stream.close() };
  });
  try {
    const policy = transportPolicy(canonical, "claude", "flat", "flat-wire-session", wire);
    const turn = await sendTransport(adapter, "flat", policy);
    assert.equal(turn.isError, false);
    assert.deepEqual(validateStructuredCandidate(canonical, turn.structured, wire, policy.selectedDispatch), { version: 1, value: "ok" });
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
    const turn = await sendTransport(adapter, "wait for native result", transportPolicy(contract, "codex", "idle-dispatch", "idle-thread"));
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


test("Codex early notifications do not charge final content twice after native binding", async () => {
  const collector = new CodexTurnCollector("session", true, undefined, 1024);
  const text = "x".repeat(800);
  collector.ingest("item/completed", { threadId: "session", turnId: "turn", item: { id: "item", type: "agentMessage", phase: "final_answer", text } });
  collector.ingest("turn/completed", { threadId: "session", turn: { id: "turn", status: "completed" } });
  collector.bind("turn");
  await collector.completion;
  assert.equal(collector.final().text, text);
});

for (const bytes of [1023, 1024, 1025]) test(`Codex selected response budget accepts only <=1024 UTF-8 bytes (${bytes})`, async () => {
  const collector = new CodexTurnCollector("session", true, undefined, 1024);
  collector.bind("turn");
  const text = "é".repeat(Math.floor(bytes / 2)) + (bytes % 2 ? "x" : "");
  assert.equal(Buffer.byteLength(text), bytes);
  collector.ingest("item/completed", { threadId: "session", turnId: "turn", item: { id: "item", type: "agentMessage", phase: "final_answer", text } });
  collector.ingest("turn/completed", { threadId: "session", turn: { id: "turn", status: "completed" } });
  if (bytes > 1024) {
    await assert.rejects(collector.completion, /limit exceeded/);
    assert.throws(() => collector.final(), /limit exceeded/);
  } else {
    await collector.completion;
    assert.equal(collector.final().text, text);
  }
});

test("Claude SDK native objects enforce exact selected bytes including decoded JSON overhead", async () => {
  const output = outputContract("claude-byte-boundary", z.strictObject({ value: z.string() }));
  const descriptor = createProviderWireContract({ ...testWire(output, "claude"), maximumResponseBytes: 64 });
  const Constructor = ClaudeAdapter as unknown as new (opts: BuilderAdapterOptions, query: (input: any) => any) => ClaudeAdapter;
  let ordinal = 0;
  const producers: Promise<void>[] = [];
  const adapter = new Constructor({ cwd: "/tmp", permission: async () => ({ behavior: "deny", message: "No tools" }) }, config => {
    const stream = new AsyncQueue<unknown>();
    stream.push({ type: "system", subtype: "init", session_id: "byte-session", cwd: "/tmp" });
    producers.push((async () => {
      for await (const _input of config.prompt) {
        const bytes = 64 + ordinal++;
        const overhead = Buffer.byteLength(JSON.stringify({ value: "" }));
        const remaining = bytes - overhead;
        const value = { value: "é".repeat(Math.floor(remaining / 2)) + (remaining % 2 ? "x" : "") };
        assert.equal(Buffer.byteLength(JSON.stringify(value)), bytes);
        const hook = config.options.hooks.PreToolUse[0].hooks[0];
        const decision = await hook({ hook_event_name: "PreToolUse", tool_name: "StructuredOutput", tool_input: value, tool_use_id: `bytes-${bytes}`, cwd: "/tmp" });
        assert.equal(decision.hookSpecificOutput?.permissionDecision === "deny", bytes > 64);
        stream.push({ type: "result", subtype: "success", uuid: `terminal-${bytes}`, session_id: "byte-session", result: "Display only", structured_output: value,
          is_error: false, num_turns: 1, total_cost_usd: 0 });
      }
    })());
    return { initializationResult: async () => ({}), [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](), close: () => stream.close(), interrupt: async () => stream.close() };
  });
  try {
    for (const bytes of [64, 65]) {
      const policy = transportPolicy(output, "claude", `bytes-${bytes}`, "byte-session", descriptor);
      const result = await sendTransport(adapter, "Native byte fixture", policy);
      assert.equal(result.isError, bytes > 64);
      assert.equal(result.structured?.state, bytes > 64 ? "rejected" : "candidate");
      assert.equal(result.selectedDispatch?.digest, policy.selectedDispatch.digest);
    }
  } finally { await adapter.close(); await Promise.all(producers); }
});

for (const provider of ["claude", "codex"] as const) test(`${provider} selected schema budget includes exact JSON bytes`, () => {
  const descriptor = testWire(contract, provider);
  const exact = Buffer.byteLength(JSON.stringify(descriptor.wireSchema));
  assert.doesNotThrow(() => createProviderWireContract({ ...descriptor, maximumSchemaBytes: exact }));
  assert.throws(() => createProviderWireContract({ ...descriptor, maximumSchemaBytes: exact - 1 }), /byte limit/);
});
