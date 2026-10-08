import { test } from "node:test";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import type { HookCallback, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import type { BuilderAdapterOptions } from "../src/adapters/types.js";
import { AsyncQueue } from "../src/util/asyncQueue.js";

const testCwd = realpathSync.native("/tmp");

const options: BuilderAdapterOptions = {
  cwd: testCwd, configRoot: testCwd, sessionRole: "qa", sessionStream: "qa",
  workspaceIdentity: "test-session-workspace",
  permission: async () => ({ behavior: "deny", message: "QA is read-only" }),
};

function claudeFixture(initialization: Promise<unknown> = Promise.resolve({}), localContext = false) {
  const messages = new AsyncQueue<SDKMessage>();
  let hook!: HookCallback;
  let prompts = 0;
  let promptPump!: Promise<void>;
  const query = (input: {
    prompt: AsyncIterable<SDKUserMessage>;
    options: { hooks: { SessionStart: Array<{ hooks: HookCallback[] }> }; abortController: AbortController };
  }): Query => {
    hook = input.options.hooks.SessionStart[0].hooks[0];
    input.options.abortController.signal.addEventListener("abort", () => messages.close());
    promptPump = (async () => { for await (const prompt of input.prompt) {
      prompts += 1;
      if (localContext) {
        assert.equal(prompt.message.content, "/context");
        messages.push({ type: "system", subtype: "init", session_id: "context-session", cwd: testCwd } as SDKMessage);
        messages.push({ type: "result", subtype: "success", session_id: "context-session", result: "Context usage", is_error: false, num_turns: 0, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {} } as unknown as SDKMessage);
      }
    } })();
    return {
      [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](),
      initializationResult: () => initialization,
      applyFlagSettings: async () => {},
      getContextUsage: async () => {
        assert.ok(prompts > 0, "context control requests must follow local initialization");
        return { maxTokens: 1000, autoCompactThreshold: 650, isAutoCompactEnabled: true };
      },
      ...(localContext ? { supportedCommands: async () => [{ name: "context", builtin: true }] } : {}),
      interrupt: async () => { messages.close(); },
    } as unknown as Query;
  };
  const adapter = Reflect.construct(ClaudeAdapter, [options, query]) as ClaudeAdapter;
  return {
    adapter, messages, prompts: () => prompts,
    start: (sessionId = "claude-session", cwd = testCwd) => hook({
      hook_event_name: "SessionStart", source: "startup", session_id: sessionId,
      cwd, transcript_path: `${testCwd}/claude-session.jsonl`,
    }, undefined, { signal: new AbortController().signal }),
    close: async () => { await adapter.close(); await promptPump; },
  };
}

test("fresh Claude QA observes startup identity without sending a user prompt", async () => {
  const fixture = claudeFixture();
  try {
    const ready = fixture.adapter.prepareSession(1000);
    await fixture.start();
    const ref = await ready;
    assert.equal(ref.sessionId, "claude-session");
    assert.equal(ref.cwd, testCwd);
    assert.equal(ref.source, "observed");
    assert.ok(ref.validatedAt);
    assert.equal(fixture.prompts(), 0);
  } finally { await fixture.close(); }
});

test("Claude QA initialization timeout aborts even when the control handshake never settles", async () => {
  const fixture = claudeFixture(new Promise(() => {}));
  try {
    await assert.rejects(fixture.adapter.prepareSession(10), /within 10ms/);
    assert.equal(fixture.prompts(), 0);
    const turn = await fixture.adapter.sendTurn("must not dispatch");
    assert.equal(turn.isError, true);
    assert.equal(fixture.prompts(), 0);
  } finally { await fixture.close(); }
});

test("closing Claude QA interrupts pending identity preparation", async () => {
  const fixture = claudeFixture(new Promise(() => {}));
  const ready = fixture.adapter.prepareSession(1000);
  const rejected = assert.rejects(ready, /closed during initialization/);
  await fixture.close();
  await rejected;
  assert.equal(fixture.prompts(), 0);
});

test("Claude QA does not validate a session ID without observing its cwd", async () => {
  const fixture = claudeFixture();
  try {
    fixture.messages.push({ type: "system", subtype: "status", session_id: "claude-session", status: null } as SDKMessage);
    await assert.rejects(fixture.adapter.prepareSession(10), /within 10ms/);
    assert.equal(fixture.adapter.sessionRef()?.validatedAt, undefined);
    assert.equal(fixture.prompts(), 0);
  } finally { await fixture.close(); }
});

test("Claude QA rejects observed startup cwd before adopting its identity", async () => {
  const fixture = claudeFixture();
  try {
    const ready = assert.rejects(fixture.adapter.prepareSession(1000), /cwd.*does not match/);
    await assert.rejects(fixture.start("wrong-cwd-session", "/"), /cwd.*does not match/);
    await ready;
    assert.equal(fixture.adapter.sessionId(), undefined);
    assert.equal(fixture.adapter.sessionRef(), undefined);
  } finally { await fixture.close(); }
});

test("Claude identity change after initialization is terminal and preserves the original identity", async () => {
  const fixture = claudeFixture();
  try {
    await fixture.start();
    const original = await fixture.adapter.prepareSession(1000);
    await assert.rejects(fixture.start("different-session"), /instead of requested session/);
    assert.equal(fixture.adapter.sessionId(), original.sessionId);
    assert.deepEqual(fixture.adapter.sessionRef(), original);
    const turn = await fixture.adapter.sendTurn("must not dispatch");
    assert.equal(turn.isError, true);
    assert.equal(fixture.prompts(), 0);
  } finally { await fixture.close(); }
});

test("Codex fresh QA preparation and post-review compaction use no setup model turn", async () => {
  const adapter = new CodexAdapter({ ...options, autoCompactThresholdPercent: 50, allowAutoCompactionSetupTurn: false });
  const internal = adapter as unknown as {
    initialized: boolean; threadAttached: boolean; usage?: { used: number; maximum: number };
    ensureConnection(): Promise<void>; restartForAutoCompaction(): Promise<void>;
    request(method: string): Promise<unknown>;
  };
  const methods: string[] = [];
  internal.ensureConnection = async () => { internal.initialized = true; };
  internal.request = async (method) => { methods.push(method); return { thread: { id: "codex-thread", cwd: "/tmp" } }; };
  internal.restartForAutoCompaction = async () => { internal.threadAttached = false; };
  try {
    const original = await adapter.prepareSession();
    await adapter.prepareAutoCompaction();
    assert.deepEqual(methods, ["thread/start"]);
    assert.ok(original.validatedAt);
    internal.usage = { used: 10, maximum: 100 };
    const policy = await adapter.prepareAutoCompaction();
    assert.equal(policy?.triggerTokens, 50);
    assert.deepEqual(methods, ["thread/start", "thread/resume"]);
    const current = adapter.sessionRef()!;
    for (const field of ["sessionId", "provider", "cwd", "configRoot", "role", "stream", "generation"] as const) {
      assert.equal(current[field], original[field]);
    }
  } finally { await adapter.close(); }
});

test("Codex fresh QA fails closed when provider cwd is missing or different", async () => {
  for (const cwd of [undefined, "/"]) {
    const adapter = new CodexAdapter(options);
    const internal = adapter as unknown as {
      ensureConnection(): Promise<void>; request(method: string): Promise<unknown>;
    };
    internal.ensureConnection = async () => {};
    internal.request = async () => ({ thread: { id: "wrong-cwd-thread", cwd } });
    try {
      await assert.rejects(adapter.prepareSession(), /cwd.*does not match/);
      assert.equal(adapter.sessionId(), undefined);
      assert.equal(adapter.sessionRef(), undefined);
    } finally { await adapter.close(); }
  }
});


test("Claude QA initializes through an advertised local context command when startup identity is lazy", async () => {
  const fixture = claudeFixture(Promise.resolve({}), true);
  try {
    const ref = await fixture.adapter.prepareSession(1000);
    assert.equal(ref.sessionId, "context-session");
    assert.ok(ref.validatedAt);
    assert.equal(fixture.prompts(), 1, "only the advertised no-model local command is sent");
  } finally { await fixture.close(); }
});

test("Claude compaction preparation initializes before context control requests", async () => {
  const fixture = claudeFixture(Promise.resolve({}), true);
  try {
    const policy = await fixture.adapter.prepareAutoCompaction(65);
    assert.equal(policy?.effectiveThresholdPercent, 65);
    assert.equal(fixture.prompts(), 1);
    assert.ok(fixture.adapter.sessionRef()?.validatedAt);
    await fixture.adapter.prepareAutoCompaction(65);
    assert.equal(fixture.prompts(), 1, "prepared sessions do not repeat initialization");
  } finally { await fixture.close(); }
});
