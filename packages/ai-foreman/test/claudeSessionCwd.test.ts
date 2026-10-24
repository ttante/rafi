import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { AsyncQueue } from "../src/util/asyncQueue.js";
import type { BuilderAdapterOptions } from "../src/adapters/types.js";
import { canonicalSessionPath, createProviderSessionRef } from "../src/sessionIdentity.js";

for (const scenario of ["nested", "outside", "changed-session", "wrong-launch", "symlink-escape"] as const) {
  test(`Claude session scope: ${scenario}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "rafi-cwd-"));
    const project = join(root, "project");
    const nested = join(project, "src");
    const outside = join(root, "other-project");
    mkdirSync(nested, { recursive: true }); mkdirSync(outside);
    const stream = new AsyncQueue<unknown>();
    const Constructor = ClaudeAdapter as unknown as new (opts: BuilderAdapterOptions, query: () => unknown) => ClaudeAdapter;
    const adapter = new Constructor({ cwd: project, permission: async () => ({ behavior: "deny", message: "fixture" }) }, () => ({ [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](), interrupt: async () => stream.close() }));
    try {
      const first = adapter.sendTurn("first");
      stream.push({ type: "system", subtype: "init", session_id: "session-1", cwd: scenario === "wrong-launch" ? outside : project });
      stream.push({ type: "result", subtype: "success", result: "first", is_error: false, num_turns: 1, total_cost_usd: 0 });
      const initial = await first;
      if (scenario === "wrong-launch") { assert.equal(initial.isError, true); return; }
      assert.equal(initial.isError, false);
      if (scenario === "symlink-escape") symlinkSync(outside, join(project, "escape"), process.platform === "win32" ? "junction" : "dir");
      const second = adapter.sendTurn("second");
      stream.push({ type: "system", subtype: "init", session_id: scenario === "changed-session" ? "session-2" : "session-1", cwd: scenario === "outside" ? outside : scenario === "symlink-escape" ? join(project, "escape") : nested });
      stream.push({ type: "result", subtype: "success", result: "second", is_error: false, num_turns: 1, total_cost_usd: 0 });
      const result = await second;
      assert.equal(result.isError, scenario !== "nested");
      assert.equal(adapter.sessionRef()?.cwd, canonicalSessionPath(project));
      assert.equal(adapter.sessionId(), "session-1");
    } finally { await adapter.close(); rmSync(root, { recursive: true, force: true }); }
  });
}

test("resumed Claude connection obtains current identity through its local command despite a previously validated reference", async () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-resumed-init-")); mkdirSync(join(root, "src"));
  const ref = createProviderSessionRef({ provider: "claude", sessionId: "resumed", cwd: root, configRoot: root, role: "builder", stream: "builder", validatedAt: new Date().toISOString() });
  const stream = new AsyncQueue<unknown>();
  const instructions: string[] = [];
  let producer: Promise<void> | undefined;
  const Constructor = ClaudeAdapter as unknown as new (opts: BuilderAdapterOptions, query: (input: { prompt: AsyncIterable<{ message: { content: string } }> }) => unknown) => ClaudeAdapter;
  const adapter = new Constructor({ cwd: root, resumeSessionRef: ref, permission: async () => ({ behavior: "deny", message: "fixture" }) }, ({ prompt }) => {
    producer = (async () => {
      for await (const input of prompt) {
        instructions.push(input.message.content);
        stream.push({ type: "system", subtype: "init", session_id: "resumed", cwd: join(root, "src") });
        stream.push({ type: "result", subtype: "success", session_id: "resumed", result: "Local context", is_error: false, num_turns: 0, total_cost_usd: 17, usage: { input_tokens: 0, output_tokens: 0 } });
      }
    })();
    return { initializationResult: async () => ({}), supportedCommands: async () => [{ name: "context", builtin: true }], [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](), interrupt: async () => stream.close() };
  });
  try { assert.equal((await adapter.prepareSession(1000)).sessionId, "resumed"); assert.deepEqual(instructions, ["/context"]); assert.equal(adapter.sessionRef()?.cwd, canonicalSessionPath(root)); }
  finally { await adapter.close(); await producer; rmSync(root, { recursive: true, force: true }); }
});

for (const submitted of [false, true]) test(`Claude identity rejection is ${submitted ? "uncertain after SDK consumption" : "not sent before SDK consumption"}`, async () => {
  const stream = new AsyncQueue<unknown>();
  let prompt!: AsyncIterable<unknown>;
  const Constructor = ClaudeAdapter as unknown as new (opts: BuilderAdapterOptions, query: (input: { prompt: AsyncIterable<unknown> }) => unknown) => ClaudeAdapter;
  const adapter = new Constructor({ cwd: "/tmp/rafi-dispatch-fixture", permission: async () => ({ behavior: "deny", message: "fixture" }) }, input => {
    prompt = input.prompt;
    return { [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](), interrupt: async () => stream.close() };
  });
  const internal = adapter as unknown as { observeSession(id: string, cwd: string): void };
  try {
    internal.observeSession("expected", "/tmp/rafi-dispatch-fixture");
    const turn = adapter.sendTurn("continue");
    await new Promise(resolve => setImmediate(resolve));
    if (submitted) await prompt[Symbol.asyncIterator]().next();
    assert.throws(() => internal.observeSession("other", "/tmp/rafi-dispatch-fixture"), /instead of requested/);
    assert.equal((await turn).failure?.dispatchState, submitted ? "unknown" : "not-sent");
  } finally { await adapter.close(); }
});

test("Claude cannot submit buffered input after a proven pre-submit cancellation", async () => {
  const stream = new AsyncQueue<unknown>();
  let input!: AsyncIterator<unknown>;
  const Constructor = ClaudeAdapter as unknown as new (opts: BuilderAdapterOptions, query: (options: { prompt: AsyncIterable<unknown> }) => unknown) => ClaudeAdapter;
  const adapter = new Constructor({ cwd: "/tmp/rafi-buffered-fixture", permission: async () => ({ behavior: "deny", message: "fixture" }) }, ({ prompt }) => {
    input = prompt[Symbol.asyncIterator]();
    return { [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](), interrupt: async () => stream.close() };
  });
  const turn = adapter.sendTurn("must never reach the provider");
  await adapter.close();
  assert.equal((await turn).failure?.dispatchState, "not-sent");
  assert.equal((await input.next()).done, true, "closed buffered host input must not be yielded to the SDK");
});

test("concurrent Claude shutdown callers wait for the same drain and settle the active turn", async () => {
  const stream = new AsyncQueue<unknown>();
  let release!: () => void;
  const interrupted = new Promise<void>(resolve => { release = resolve; });
  const Constructor = ClaudeAdapter as unknown as new (opts: BuilderAdapterOptions, query: () => unknown) => ClaudeAdapter;
  const adapter = new Constructor({ cwd: "/tmp/rafi-shutdown-fixture", permission: async () => ({ behavior: "deny", message: "fixture" }) }, () => ({ [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](), interrupt: async () => { await interrupted; stream.close(); } }));
  const turn = adapter.sendTurn("work"); await new Promise(resolve => setImmediate(resolve));
  const first = adapter.close(); const second = adapter.close();
  assert.equal(first, second);
  assert.equal((await turn).isError, true);
  let drained = false; void second.then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
  release(); await first; assert.equal(drained, true);
});


test("live query reserves before SDK launch, enforces native dollars and records terminal cost", async () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-claude-budget-"));
  const stream = new AsyncQueue<unknown>(), controller = new AbortController();
  let reserved = 0, settled = 0, observed: number | undefined;
  const Constructor = ClaudeAdapter as unknown as new (opts: BuilderAdapterOptions, query: (request: any) => unknown) => ClaudeAdapter;
  const adapter = new Constructor({ cwd: root, permission: async () => ({ behavior: "deny", message: "fixture" }),
    queryBudget: { reserveQuery(provider) { assert.equal(provider, "claude"); reserved++;
      return { maximumSpendUsd: 0.25, signal: controller.signal, record(cost) { observed = cost; }, close() { settled++; } }; } },
  }, request => {
    assert.equal(reserved, 1); assert.equal(request.options.maxBudgetUsd, 0.25);
    return { [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](), interrupt: async () => stream.close() };
  });
  try {
    const pending = adapter.sendTurn("Non-authoritative transport fixture");
    stream.push({ type: "system", subtype: "init", session_id: "budget-session", cwd: root });
    stream.push({ type: "result", subtype: "success", result: "display", is_error: false, num_turns: 1, total_cost_usd: 0.12 });
    assert.equal((await pending).isError, false); assert.equal(observed, 0.12);
  } finally { await adapter.close(); rmSync(root, { recursive: true, force: true }); }
  assert.equal(settled, 1);
});
