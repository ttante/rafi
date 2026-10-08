import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter, parseCodexLine } from "../src/adapters/codex.js";
import type { BuilderAdapterOptions } from "../src/adapters/types.js";

const CWD = "/work/project";

function makeOpts(overrides: Partial<BuilderAdapterOptions> = {}): BuilderAdapterOptions {
  return {
    cwd: CWD,
    permission: async () => ({ behavior: "allow" }),
    ...overrides,
  };
}

function adapter(overrides: Partial<BuilderAdapterOptions> = {}): CodexAdapter {
  return new CodexAdapter(makeOpts(overrides));
}

function withPath(path: string, fn: () => Promise<void> | void): Promise<void> {
  const originalPath = process.env.PATH;
  process.env.PATH = path;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      process.env.PATH = originalPath;
    });
}

// ── buildArgs ────────────────────────────────────────────────────────────────

test("buildArgs: baseline includes required flags and instruction", () => {
  const a = adapter();
  const args = a.buildArgs("do the thing");
  assert.ok(args.includes("--json"), "missing --json");
  assert.ok(args.includes("--skip-git-repo-check"), "missing --skip-git-repo-check");
  assert.ok(args.includes("--sandbox"), "missing --sandbox");
  assert.ok(args.includes("workspace-write"), "missing workspace-write");
  assert.ok(args.includes("-C"), "missing -C");
  assert.ok(args.includes(CWD), "missing cwd");
  assert.equal(args[args.length - 1], "do the thing", "instruction must be last");
  assert.ok(!args.includes("resume"), "should not include resume on first turn");
});

test("Codex instruction uses the Codex-specific skill when runtime artifacts conflict", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "codex-skill-dispatch-"));
  try {
    mkdirSync(join(cwd, ".codex/skills/review"), { recursive: true });
    mkdirSync(join(cwd, ".agents/skills/review"), { recursive: true });
    writeFileSync(join(cwd, ".codex/skills/review/SKILL.md"), "codex exact body\n");
    writeFileSync(join(cwd, ".agents/skills/review/SKILL.md"), "generic conflicting body\n");
    const a = adapter({ cwd, skills: ["review"], systemPromptAppend: "QA ROLE" });
    const instruction = a.buildInstruction("review now");
    assert.match(instruction, /codex exact body/);
    assert.doesNotMatch(instruction, /generic conflicting body/);
    await a.close();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("buildArgs: read-only sandbox override", () => {
  const args = adapter({ sandboxMode: "read-only" }).buildArgs("inspect only");
  const idx = args.indexOf("--sandbox");
  assert.ok(idx !== -1, "missing --sandbox");
  assert.equal(args[idx + 1], "read-only");
  assert.ok(!args.includes("workspace-write"), "workspace-write should not be used");
});

test("buildArgs: model flag", () => {
  const args = adapter({ model: "gpt-5.4" }).buildArgs("x");
  const idx = args.indexOf("-m");
  assert.ok(idx !== -1, "missing -m");
  assert.equal(args[idx + 1], "gpt-5.4");
});

test("buildArgs: effort flag", () => {
  const args = adapter({ effort: "high" }).buildArgs("x");
  const idx = args.indexOf("-c");
  assert.ok(idx !== -1, "missing -c");
  assert.equal(args[idx + 1], "model_reasoning_effort=high");
});

test("buildArgs: fast flag maps to effort=low", () => {
  const args = adapter({ fast: true }).buildArgs("x");
  const idx = args.indexOf("-c");
  assert.ok(idx !== -1, "missing -c");
  assert.equal(args[idx + 1], "model_reasoning_effort=low");
});

test("buildArgs: effort takes precedence over fast", () => {
  const args = adapter({ effort: "xhigh", fast: true }).buildArgs("x");
  const occurrences = args.filter((a) => a === "-c").length;
  assert.equal(occurrences, 1, "only one -c expected");
  const idx = args.indexOf("-c");
  assert.equal(args[idx + 1], "model_reasoning_effort=xhigh");
});

test("buildArgs: no effort args when neither effort nor fast set", () => {
  const args = adapter().buildArgs("x");
  assert.ok(!args.includes("-c"), "unexpected -c flag");
});

test("buildArgs: resume subcommand when sessionId is set", () => {
  const a = adapter();
  // Simulate a session being established
  (a as unknown as { _sessionId: string })._sessionId = "abc-123";
  const args = a.buildArgs("next step");
  const resumeIdx = args.indexOf("resume");
  assert.ok(resumeIdx !== -1, "missing resume subcommand");
  assert.equal(args[resumeIdx + 1], "abc-123", "session id must follow resume");
  assert.equal(args[args.length - 1], "next step", "instruction must still be last");
});

test("buildArgs: resumeSessionId option seeds first turn resume", () => {
  const args = adapter({ resumeSessionId: "seed-session" }).buildArgs("continue ticket");
  const resumeIdx = args.indexOf("resume");
  assert.ok(resumeIdx !== -1, "missing resume subcommand");
  assert.equal(args[resumeIdx + 1], "seed-session");
  assert.equal(args[args.length - 1], "continue ticket");
});

// ── parseCodexLine ───────────────────────────────────────────────────────────

function parse(line: string) {
  return parseCodexLine(JSON.parse(line) as Record<string, unknown>);
}

test("parseCodexLine: thread.started captures session ID", () => {
  const result = parse('{"type":"thread.started","thread_id":"my-id-42"}');
  assert.equal(result.sessionId, "my-id-42");
  assert.equal(result.events.length, 0);
});

test("parseCodexLine: agent_message emits text event and text", () => {
  const result = parse(
    '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"hello"}}',
  );
  assert.equal(result.events.length, 1);
  assert.deepEqual(result.events[0], { kind: "text", text: "hello" });
  assert.equal(result.text, "hello");
});

test("parseCodexLine: command_execution emits tool event (no text)", () => {
  const result = parse(
    '{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"/bin/bash -lc \'ls\'","aggregated_output":"file.ts\\n","exit_code":0,"status":"completed"}}',
  );
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]?.kind, "tool");
  const ev = result.events[0] as { kind: "tool"; name: string };
  assert.equal(ev.name, "command_execution");
  assert.equal(result.text, undefined);
});

test("parseCodexLine: item.started produces no events", () => {
  const result = parse(
    '{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"ls","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
  );
  assert.equal(result.events.length, 0);
  assert.equal(result.sessionId, undefined);
  assert.equal(result.text, undefined);
});

test("parseCodexLine: error event", () => {
  const result = parse('{"type":"error","error":{"message":"something went wrong"}}');
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]?.kind, "error");
  const ev = result.events[0] as { kind: "error"; message: string };
  assert.equal(ev.message, "something went wrong");
});

test("parseCodexLine: turn.started and turn.completed produce no events", () => {
  assert.equal(parse('{"type":"turn.started"}').events.length, 0);
  assert.equal(
    parse('{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":50}}').events.length,
    0,
  );
});

test("Codex app-server recoverable error emits retry instead of terminal error", async () => {
  const a = adapter();
  const iterator = a.events()[Symbol.asyncIterator]();
  (a as unknown as { handle(message: unknown): void }).handle({
    method: "error",
    params: { error: { message: "Connection closed mid-response" }, willRetry: true },
  });
  assert.deepEqual((await iterator.next()).value, {
    kind: "retry",
    provider: "codex",
    reason: "Connection closed mid-response",
    managedBy: "provider",
  });
  await a.close();
});

test("Codex app-server non-recoverable error remains terminal", async () => {
  const a = adapter();
  const iterator = a.events()[Symbol.asyncIterator]();
  (a as unknown as { handle(message: unknown): void }).handle({
    method: "error",
    params: { error: { message: "Authentication failed" }, willRetry: false },
  });
  assert.deepEqual((await iterator.next()).value, { kind: "error", message: "Authentication failed" });
  await a.close();
});

test("Codex app-server turn waiter fails rather than waiting forever after provider silence", async () => {
  const a = adapter();
  const internal = a as unknown as {
    waitFor(method: string, predicate: (params: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>;
  };
  await assert.rejects(
    internal.waitFor("turn/completed", () => false, 15),
    /provider wait timed out after 15 ms while waiting for turn\/completed/,
  );
  await a.close();
});

test("Codex app-server preserves complete file-change and future item payloads", async () => {
  const a = adapter();
  const iterator = a.events()[Symbol.asyncIterator]();
  const fileChange = { id: "fc-1", type: "fileChange", changes: [{ path: "src/a.ts", kind: "update", patch: "exact" }], providerFutureField: { nested: true } };
  (a as unknown as { handle(message: unknown): void }).handle({ method: "item/started", params: { item: fileChange } });
  const raw = (await iterator.next()).value;
  assert.equal(raw.kind, "provider-item");
  assert.deepEqual(raw.payload, fileChange);
  const tool = (await iterator.next()).value;
  assert.equal(tool.kind, "tool");
  assert.deepEqual(tool.input, fileChange);
  assert.equal(tool.inputCompleteness, "complete");
  assert.equal((await iterator.next()).value.kind, "activity");

  const future = { id: "future-1", type: "futureToolKind", arbitrary: [1, { two: 2 }] };
  (a as unknown as { handle(message: unknown): void }).handle({ method: "item/completed", params: { item: future } });
  const futureEvent = (await iterator.next()).value;
  assert.equal(futureEvent.kind, "provider-item");
  assert.deepEqual(futureEvent.payload, future);
  await a.close();
});

test("Codex token usage keeps live context and cumulative provider totals separate", async () => {
  const a = adapter();
  (a as unknown as { handle(message: unknown): void }).handle({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "session-1",
      tokenUsage: {
        total: { totalTokens: 72, inputTokens: 50, outputTokens: 22 },
        last: { totalTokens: 12, inputTokens: 9, outputTokens: 3 },
        modelContextWindow: 100,
      },
    },
  });
  assert.deepEqual(await a.contextUsage(), {
    used: 12, maximum: 100, percentage: 12, observedAt: (await a.contextUsage())?.observedAt, source: "provider-event",
  });
  assert.deepEqual(await a.sessionUsage(), {
    inputTokens: 50, outputTokens: 22, totalTokens: 72,
    observedAt: (await a.sessionUsage())?.observedAt, source: "provider",
  });
  await a.close();
});

test("Codex native compaction requires explicit completion and a fresh post-compact usage sample", async () => {
  const a = adapter({ resumeSessionId: "session-1" });
  const internal = a as unknown as {
    ensureThread(): Promise<void>;
    request(method: string): Promise<unknown>;
    handle(message: unknown): void;
  };
  internal.ensureThread = async () => {};
  internal.handle({ method: "thread/tokenUsage/updated", params: { threadId: "session-1", tokenUsage: { total: { totalTokens: 80, inputTokens: 60, outputTokens: 20 }, last: { totalTokens: 10, inputTokens: 8, outputTokens: 2 }, modelContextWindow: 100 } } });
  internal.request = async () => {
    queueMicrotask(() => {
      internal.handle({ method: "item/completed", params: { threadId: "session-1", item: { type: "contextCompaction" } } });
      internal.handle({ method: "thread/tokenUsage/updated", params: { threadId: "session-1", tokenUsage: { total: { totalTokens: 80, inputTokens: 60, outputTokens: 20 }, last: { totalTokens: 4, inputTokens: 3, outputTokens: 1 }, modelContextWindow: 100 } } });
    });
    return {};
  };
  assert.deepEqual(await a.compact(), { ok: true });
  assert.equal((await a.contextUsage())?.percentage, 4);
  await a.close();
});

test("Codex native compaction rejects completion without authoritative post-compact usage", async () => {
  const a = adapter({ resumeSessionId: "session-1" });
  const internal = a as unknown as {
    ensureThread(): Promise<void>;
    request(method: string): Promise<unknown>;
    waitFor(method: string): Promise<Record<string, unknown>>;
  };
  internal.ensureThread = async () => {};
  internal.request = async () => ({});
  internal.waitFor = async (method) => {
    if (method === "item/completed") return { threadId: "session-1", item: { type: "contextCompaction" } };
    throw new Error("fresh usage unavailable");
  };
  const result = await a.compact();
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /fresh usage unavailable/);
  await a.close();
});

test("failed compaction acknowledgement removes both registered waiters and traces the failure", async () => {
  const phases: string[] = [];
  const a = adapter({ resumeSessionId: "session-1", compactionTimeoutMs: 50, onLifecycleTrace: event => phases.push(event.phase) });
  const internal = a as unknown as { ensureThread(): Promise<void>; request(method: string): Promise<unknown>; notificationWaiters: Map<string, unknown[]> };
  internal.ensureThread = async () => {};
  internal.request = async () => { throw new Error("acknowledgement failed"); };
  assert.equal((await a.compact()).ok, false);
  assert.equal([...internal.notificationWaiters.values()].flat().length, 0);
  assert.ok(phases.includes("waiter-registered")); assert.ok(phases.includes("waiter-cancelled")); assert.ok(phases.includes("compaction-failed"));
  await a.close();
});

test("wrong-session compaction completion times out without accepting stale usage", async () => {
  const a = adapter({ resumeSessionId: "session-1", compactionTimeoutMs: 20 });
  const internal = a as unknown as { ensureThread(): Promise<void>; request(method: string): Promise<unknown>; handle(message: unknown): void; notificationWaiters: Map<string, unknown[]> };
  internal.ensureThread = async () => {};
  internal.request = async () => {
    internal.handle({ method: "item/completed", params: { threadId: "foreign", item: { type: "contextCompaction" } } });
    return {};
  };
  const result = await a.compact(); assert.equal(result.ok, false); assert.match(result.error!, /20 ms/);
  assert.equal([...internal.notificationWaiters.values()].flat().length, 0);
  await a.close();
});

test("Codex automatic compaction discovers the provider window before restarting with a native ceiling", async () => {
  const a = adapter({ autoCompactThresholdPercent: 50 });
  const internal = a as unknown as {
    usage: { maximum: number };
    ensureThread(): Promise<void>;
    sendTurnInternal(text: string): Promise<{ isError: boolean; text: string }>;
    restartForAutoCompaction(): Promise<void>;
  };
  let ensured = 0;
  let restarted = 0;
  internal.ensureThread = async () => { ensured += 1; };
  internal.sendTurnInternal = async () => {
    internal.usage = { maximum: 200 };
    return { isError: false, text: "context is ready" };
  };
  internal.restartForAutoCompaction = async () => { restarted += 1; };
  await a.prepareAutoCompaction();
  assert.equal(ensured, 2, "the configured server must resume the discovered thread");
  assert.equal(restarted, 1);
  assert.deepEqual(a.buildAppServerArgs(), [
    "app-server", "--listen", "stdio://",
    "-c", "model_auto_compact_token_limit=100",
    "-c", 'model_auto_compact_token_limit_scope="total"',
  ]);
  await a.close();
});

test("Codex records provider-triggered compactions when completion follows usage", async () => {
  const a = adapter({ resumeSessionId: "session-1" });
  const internal = a as unknown as { handle(message: unknown): void; nativeCompactions: unknown[] };
  internal.handle({ method: "thread/tokenUsage/updated", params: { threadId: "session-1", tokenUsage: { total: { totalTokens: 80 }, last: { totalTokens: 25 }, modelContextWindow: 100 } } });
  internal.handle({ method: "item/completed", params: { threadId: "session-1", item: { type: "contextCompaction" } } });
  const recorded = a.drainNativeCompactions();
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.provider, "codex");
  assert.equal(recorded[0]?.usageRevision, 1, "the event records which cached usage generation preceded compaction");
  assert.equal(a.drainNativeCompactions().length, 0, "draining is idempotent");
  await a.close();
});

test("Codex records provider-triggered compactions when usage follows completion without duplication", async () => {
  const a = adapter({ resumeSessionId: "session-1" });
  const internal = a as unknown as { handle(message: unknown): void; nativeCompactions: unknown[] };
  internal.handle({ method: "item/completed", params: { threadId: "session-1", item: { type: "contextCompaction" } } });
  assert.equal(a.drainNativeCompactions().length, 1);
  internal.handle({ method: "thread/tokenUsage/updated", params: { threadId: "session-1", tokenUsage: { total: { totalTokens: 25 }, last: { totalTokens: 25 }, modelContextWindow: 100 } } });
  assert.equal(a.drainNativeCompactions().length, 0, "a later usage event must not duplicate the completion");
  await a.close();
});

test("CodexAdapter normalizes 401 process failures into repair guidance", async () => {
  const binDir = mkdtempSync(join(tmpdir(), "codex-auth-test-"));
  const projectDir = mkdtempSync(join(tmpdir(), "codex-auth-project-"));
  const codexPath = join(binDir, "codex");
  writeFileSync(
    codexPath,
    [
      "#!/bin/sh",
      "echo '401 Invalid authentication credentials' >&2",
      "exit 1",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(codexPath, 0o755);

  await withPath(binDir, async () => {
    const a = adapter({ cwd: projectDir });
    const result = await a.sendTurn("hello");
    await a.close();

    assert.equal(result.isError, true);
    assert.match(result.text, /codex exec failed during builder turn/);
    assert.match(result.text, /codex login/);
    assert.match(result.text, /401 Invalid authentication credentials/);
  });
});

test("Codex host-turn accounting sums cumulative deltas and rejects foreign or missing occupancy", async () => {
  const a = adapter({ resumeSessionId: "session-1" });
  const internal = a as unknown as { handle(message: unknown): void; ensureThread(): Promise<void>; request(method: string): Promise<unknown> };
  const usage = (input: number, output: number, latest?: number, threadId = "session-1") => internal.handle({ method: "thread/tokenUsage/updated", params: { threadId, tokenUsage: { total: { inputTokens: input, outputTokens: output, totalTokens: input + output }, last: { totalTokens: latest }, modelContextWindow: 1000 } } });
  internal.ensureThread = async () => {};
  usage(100, 20, 30);
  internal.request = async () => {
    usage(140, 30, 50);
    usage(200, 45, 70);
    usage(200, 45, 70); // Duplicate notification does not double-charge.
    usage(900, 90, 990, "other-session");
    internal.handle({ method: "turn/completed", params: { threadId: "session-1", turn: { status: "completed" } } });
    return {};
  };
  const turn = await a.sendTurn("work");
  assert.equal(turn.inputTokens, 100);
  assert.equal(turn.outputTokens, 25);
  assert.equal((await a.contextUsage())?.used, 70);
  usage(210, 46);
  assert.equal(await a.contextUsage(), undefined, "missing latest sample remains unknown");
  internal.request = async () => {
    usage(1, 1, 2); // Counter reset: no invented negative or final-request delta.
    internal.handle({ method: "turn/completed", params: { threadId: "session-1", turn: { status: "completed" } } });
    return {};
  };
  assert.equal((await a.sendTurn("next")).inputTokens, undefined);
  await a.close();
});

test("recorded slow compactions and a ninety-second completion fit the default deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const duration of [27_935, 39_096, 48_495, 50_122, 53_314, 90_000]) {
    const a = adapter({ resumeSessionId: "session-1" });
    const internal = a as unknown as { ensureThread(): Promise<void>; request(method: string): Promise<unknown>; handle(message: unknown): void };
    internal.ensureThread = async () => {};
    internal.request = async () => {
      setTimeout(() => {
        internal.handle({ method: "thread/tokenUsage/updated", params: { threadId: "session-1", tokenUsage: { total: { totalTokens: 1000000 }, last: { totalTokens: 20 }, modelContextWindow: 100 } } });
        internal.handle({ method: "item/completed", params: { threadId: "session-1", item: { id: `compact-${duration}`, type: "contextCompaction" } } });
      }, duration);
      return {};
    };
    const completion = a.compact();
    for (let index = 0; index < 10; index++) await Promise.resolve();
    t.mock.timers.tick(duration);
    assert.equal((await completion).ok, true, `${duration}ms compaction must not trigger replacement`);
    assert.equal((await a.contextUsage())?.used, 20);
    assert.equal(a.drainNativeCompactions().length, 0, "manual completion is not counted again as native");
    await a.close();
  }
});

test("explicit compaction completion reconciles a lost acknowledgement", async () => {
  const a = adapter({ resumeSessionId: "session-1", compactionTimeoutMs: 100 });
  const internal = a as unknown as { ensureThread(): Promise<void>; request(method: string): Promise<unknown>; handle(message: unknown): void };
  internal.ensureThread = async () => {};
  internal.request = () => {
    queueMicrotask(() => {
      internal.handle({ method: "item/completed", params: { threadId: "session-1", item: { id: "compaction", type: "contextCompaction" } } });
      internal.handle({ method: "thread/tokenUsage/updated", params: { threadId: "session-1", tokenUsage: { total: { totalTokens: 9000 }, last: { totalTokens: 10 }, modelContextWindow: 100 } } });
    });
    return new Promise(() => {});
  };
  assert.equal((await a.compact()).ok, true);
  await a.close();
});

test("only the current compaction item extends the normal deadline, within a hard bound", async () => {
  for (const mode of ["correlated", "foreign-session", "generic-status", "wrong-completion", "never-completes"] as const) {
    const a = adapter({ resumeSessionId: "session-1", compactionTimeoutMs: 100 });
    const internal = a as unknown as { ensureThread(): Promise<void>; request(method: string): Promise<unknown>; handle(message: unknown): void };
    internal.ensureThread = async () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    internal.request = async () => {
      if (mode === "generic-status") internal.handle({ method: "thread/status/changed", params: { threadId: "session-1", status: { type: "active" } } });
      else internal.handle({ method: "item/started", params: { threadId: mode === "foreign-session" ? "other" : "session-1", item: { id: "our-compaction", type: "contextCompaction" } } });
      if (mode !== "never-completes") timer = setTimeout(() => {
        internal.handle({ method: "thread/tokenUsage/updated", params: { threadId: "session-1", tokenUsage: { last: { totalTokens: 10 }, modelContextWindow: 100 } } });
        internal.handle({ method: "item/completed", params: { threadId: "session-1", item: { id: mode === "wrong-completion" ? "another-compaction" : "our-compaction", type: "contextCompaction" } } });
      }, 125);
      return {};
    };
    try {
      const result = await a.compact();
      assert.equal(result.ok, mode === "correlated", mode);
      if (!result.ok) assert.equal(result.failure?.dispatchState, "unknown");
    } finally { if (timer) clearTimeout(timer); await a.close(); }
  }
});


test("Codex tool use cannot turn a response-only correction into success", async () => {
  const a = adapter({ resumeSessionId: "session-1" });
  const internal = a as unknown as { ensureThread(): Promise<void>; request(method: string): Promise<unknown>; handle(message: unknown): void };
  internal.ensureThread = async () => {};
  internal.request = async () => {
    internal.handle({ method: "item/started", params: { threadId: "session-1", item: { id: "tool-1", type: "commandExecution", command: "echo unexpected" } } });
    internal.handle({ method: "turn/completed", params: { threadId: "session-1", turn: { status: "completed" } } });
    return {};
  };
  const turn = await a.sendTurn("format only", { responseOnly: true });
  assert.equal(turn.isError, true);
  assert.match(turn.text, /Response-only correction used tools/);
  await a.close();
});
