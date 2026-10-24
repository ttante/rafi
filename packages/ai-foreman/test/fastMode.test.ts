import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeAdapter, buildClaudeQueryOptions } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { isFastModeUnavailable } from "../src/adapters/fastMode.js";
import { AsyncQueue } from "../src/util/asyncQueue.js";
import type { BuilderAdapterOptions, BuilderEvent } from "../src/adapters/types.js";

const base: BuilderAdapterOptions = { cwd: "/tmp/rafi-fast-fixture", model: "fixture-model", fast: true, effort: "high", permission: async () => ({ behavior: "deny", message: "No tools" }) };

test("fast-mode classifier excludes unrelated model/auth/transport failures", () => {
  for (const message of ["Fast mode is not supported for this model", "service_tier is invalid", "Unknown option '--fast'", "Fast mode has been disabled by your organization"]) assert.equal(isFastModeUnavailable(message), true, message);
  for (const message of ["Model not found", "Authentication failed", "Network timeout", "Connection closed", "invalid reasoning effort low"]) assert.equal(isFastModeUnavailable(message), false, message);
});

test("Claude starts at standard speed without unsupported CLI flags", () => {
  const options = buildClaudeQueryOptions(base);
  assert.equal(options.extraArgs, undefined);
  assert.deepEqual(options.settings, { fastMode: false });
  assert.equal(options.model, base.model); assert.equal(options.effort, "high");
});

function claudeFixture(input: { supports?: boolean; enableError?: string; rejectTurn?: string; toolBeforeReject?: boolean }) {
  const stream = new AsyncQueue<unknown>();
  const flags: unknown[] = []; const prompts: string[] = []; const events: BuilderEvent[] = [];
  let pump: Promise<void> | undefined;
  const Constructor = ClaudeAdapter as unknown as new (opts: BuilderAdapterOptions, query: (input: { prompt: AsyncIterable<{ message: { content: string } }> }) => unknown) => ClaudeAdapter;
  const adapter = new Constructor({ ...base }, ({ prompt }) => {
    pump = (async () => {
      for await (const message of prompt) {
        prompts.push(message.message.content);
        if (input.rejectTurn && prompts.length === 1) {
          if (input.toolBeforeReject) stream.push({ type: "assistant", message: { content: [{ type: "tool_use", id: "already-used", name: "Bash", input: {} }] } });
          stream.push({ type: "assistant", error: "invalid_request", message: { content: [{ type: "text", text: input.rejectTurn }] } });
          stream.push({ type: "result", is_error: true, errors: [input.rejectTurn], num_turns: 1, total_cost_usd: 0 });
        } else stream.push({ type: "result", subtype: "success", result: "OK", is_error: false, num_turns: message.message.content.startsWith("/model ") ? 0 : 1, total_cost_usd: 0 });
      }
    })();
    return {
      [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
      initializationResult: async () => ({ models: [{ value: base.model, supportsFastMode: input.supports }] }),
      applyFlagSettings: async (settings: { fastMode?: boolean }) => { flags.push(settings); if (settings.fastMode && input.enableError) throw new Error(input.enableError); },
      interrupt: async () => stream.close(), close: () => stream.close(),
    };
  });
  const consume = (async () => { for await (const event of adapter.events()) events.push(event); })();
  return { adapter, flags, prompts, events, close: async () => { await adapter.close(); await pump; await consume; } };
}

for (const supports of [false, undefined]) test(`Claude skips fast mode when capability is ${supports}`, async () => {
  const f = claudeFixture({ supports });
  try {
    assert.equal((await f.adapter.sendTurn("same request")).isError, false);
    assert.equal((await f.adapter.sendTurn("next request")).isError, false);
    assert.deepEqual(f.flags, []); assert.deepEqual(f.prompts, ["same request", "next request"]);
  } finally { await f.close(); }
});

test("Claude enables advertised capability and handles explicit settings rejection", async () => {
  for (const enableError of [undefined, "Fast mode is not available in this runtime"]) {
    const f = claudeFixture({ supports: true, enableError });
    try { assert.equal((await f.adapter.sendTurn("same request")).isError, false); assert.deepEqual(f.flags, enableError ? [{ fastMode: true }, { fastMode: false }] : [{ fastMode: true }]); assert.deepEqual(f.prompts, ["same request"]); }
    finally { await f.close(); }
  }
});

test("Claude retries explicit pre-work rejection once with fast disabled, without exposing failed result", async () => {
  const f = claudeFixture({ supports: true, rejectTurn: "Fast mode not supported for fixture-model" });
  try {
    assert.equal((await f.adapter.sendTurn("same request")).text, "OK");
    assert.deepEqual(f.prompts, ["same request", "same request"]);
    assert.deepEqual(f.flags, [{ fastMode: true }, { fastMode: false }]);
    assert.equal(f.events.some(event => event.kind === "text" && event.text.includes("not supported")), false);
    assert.equal(f.events.filter(event => event.kind === "turn-complete").length, 1);
  } finally { await f.close(); }
});

test("Claude model switch disables fast before moving to an unsupported model", async () => {
  const f = claudeFixture({ supports: true });
  try {
    assert.equal((await f.adapter.sendTurn("first request")).isError, false);
    assert.equal((await f.adapter.switchSettings({ model: "unsupported-model", effort: "high", fast: true })).ok, true);
    assert.equal((await f.adapter.sendTurn("next request")).isError, false);
    assert.deepEqual(f.flags, [{ fastMode: true }, { fastMode: false }]);
    assert.equal(f.adapter.graphRuntimeSettings().model, "unsupported-model");
  } finally { await f.close(); }
});

for (const input of [{ supports: true, rejectTurn: "Authentication failed" }, { supports: true, rejectTurn: "Fast mode not supported", toolBeforeReject: true }]) test(`Claude does not replay ${input.toolBeforeReject ? "tool work" : "unrelated errors"}`, async () => {
  const f = claudeFixture(input);
  try { assert.equal((await f.adapter.sendTurn("same request")).isError, true); assert.equal(f.prompts.length, 1); }
  finally { await f.close(); }
});

function codexFixture(input: { tier?: string; discoveryError?: boolean; reject?: string; rpcError?: boolean; toolBeforeReject?: boolean }) {
  const adapter = new CodexAdapter({ ...base, resumeSessionId: "same-thread" });
  const calls: Array<Record<string, unknown>> = [];
  const internal = adapter as unknown as { ensureThread(): Promise<void>; request(method: string, params: Record<string, unknown>): Promise<unknown>; handle(message: unknown): void };
  internal.ensureThread = async () => {};
  internal.request = async (method, params) => {
    if (method === "model/list") { if (input.discoveryError) throw new Error("unknown method"); return { data: [{ model: base.model, serviceTiers: input.tier ? [{ id: input.tier, name: "Fast" }] : [] }] }; }
    calls.push(params);
    const rejected = input.reject && calls.length === 1;
    if (rejected && input.rpcError) throw new Error(input.reject);
    if (rejected && input.toolBeforeReject) internal.handle({ method: "item/completed", params: { threadId: "same-thread", item: { type: "commandExecution", id: "tool", command: "fixture" } } });
    internal.handle({ method: "turn/completed", params: { threadId: "same-thread", turn: { id: `turn-${calls.length}`, status: rejected ? "failed" : "completed", ...(rejected ? { error: { message: input.reject } } : {}) } } });
    return { turn: { id: `turn-${calls.length}` } };
  };
  return { adapter, calls };
}

for (const input of [{}, { discoveryError: true }, { tier: "priority" }]) test(`Codex capability discovery ${JSON.stringify(input)} keeps model and reasoning`, async () => {
  const f = codexFixture(input);
  try {
    assert.equal((await f.adapter.sendTurn("same request")).isError, false);
    assert.equal(f.calls[0]?.model, base.model); assert.equal(f.calls[0]?.effort, "high");
    assert.equal(f.calls[0]?.serviceTier, "tier" in input ? input.tier : "default");
  } finally { await f.adapter.close(); }
});

for (const rpcError of [true, false]) test(`Codex gracefully retries ${rpcError ? "RPC" : "turn"} fast rejection`, async () => {
  const f = codexFixture({ tier: "priority", reject: "service_tier priority not supported for this model", rpcError });
  try {
    assert.equal((await f.adapter.sendTurn("same request")).isError, false);
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.calls.map(call => call.serviceTier), ["priority", "default"]);
    assert.equal(f.calls[1]?.threadId, f.calls[0]?.threadId); assert.deepEqual(f.calls[1]?.input, f.calls[0]?.input);
    assert.equal(f.calls[1]?.model, base.model); assert.equal(f.calls[1]?.effort, "high");
    assert.equal((await f.adapter.sendTurn("next request")).isError, false); assert.equal(f.calls[2]?.serviceTier, "default");
  } finally { await f.adapter.close(); }
});

for (const input of [{ tier: "priority", reject: "Authentication failed" }, { tier: "priority", reject: "service_tier not supported", toolBeforeReject: true }]) test(`Codex does not replay ${input.toolBeforeReject ? "tool work" : "unrelated errors"}`, async () => {
  const f = codexFixture(input);
  try { assert.equal((await f.adapter.sendTurn("same request")).isError, true); assert.equal(f.calls.length, 1); }
  finally { await f.adapter.close(); }
});
