import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
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
    used: 72, maximum: 100, percentage: 72, observedAt: (await a.contextUsage())?.observedAt, source: "provider-event",
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
      internal.handle({ method: "thread/tokenUsage/updated", params: { threadId: "session-1", tokenUsage: { total: { totalTokens: 24, inputTokens: 18, outputTokens: 6 }, last: { totalTokens: 4, inputTokens: 3, outputTokens: 1 }, modelContextWindow: 100 } } });
    });
    return {};
  };
  assert.deepEqual(await a.compact(), { ok: true });
  assert.equal((await a.contextUsage())?.percentage, 24);
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
