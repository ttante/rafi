// M4 follow-up 2 (user decision): rafi ends a provider with SIGTERM to its process group, waits up to 5 s on
// deps.clock for it to exit, then SIGKILLs what is left of the group (Windows: stdin's end, then `taskkill /T /F`).
// Both adapters' close() on a stepped clock, and the real signalling primitive through its seam.
import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeAgent } from "../../src/agents/claude/adapter.js";
import { codexAgent } from "../../src/agents/codex/adapter.js";
import type { ClaudeQuery, Clock, JsonRpcStream, TimerKind } from "../../src/deps/types.js";
import { signalGroup } from "../../src/deps/real/agents.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A clock whose timers fire only when the test advances it. */
function steppedClock() {
  let now = 0;
  let timers: { at: number; fn: () => void; kind: TimerKind }[] = [];
  const clock: Clock = {
    now: () => new Date(now),
    timer(ms, fn, kind) {
      const t = { at: now + ms, fn, kind };
      timers.push(t);
      return () => { timers = timers.filter((x) => x !== t); };
    },
    sleep: async () => undefined,
  };
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      const next = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      timers = timers.filter((t) => t !== next);
      now = next.at;
      next.fn();
      await flush();
    }
    now = end;
    await flush();
  };
  return { clock, advance, now: () => now, pending: () => timers.length };
}

/** A Codex app-server stream; `deaf` ignores the polite step (SIGTERM and stdin's end). */
function codexProvider(now: () => number, deaf: boolean) {
  const ops: [string, number][] = [];
  const fns = new Set<(i: { code: number | null }) => void>();
  const exit = (code: number | null) => { for (const fn of [...fns]) fn({ code }); };
  const stream: JsonRpcStream = {
    write: () => undefined,
    onMessage: () => () => undefined,
    onClose(fn) { fns.add(fn); return () => fns.delete(fn); },
    async close() { ops.push(["term", now()]); if (!deaf) exit(143); },
    kill() { ops.push(["kill", now()]); exit(null); },
  };
  return { stream, ops };
}

const unavailable = (() => { throw new Error("not in this test"); }) as never;
const REQUEST = { meta: { key: "T1:build:1", role: "builder" as const }, message: "go",
  schema: { name: "done", json: {}, codex: {} }, grants: [], tools: [] };

for (const deaf of [true, false]) {
  test(`Codex: close() sends SIGTERM, then SIGKILL ${deaf ? "5 s later on the clock (it ignored SIGTERM)"
    : "at once when it has exited"}; a second close() sends nothing more`, async () => {
    const c = steppedClock();
    const p = codexProvider(c.now, deaf);
    const agent = codexAgent({ deps: { agents: { codex: () => p.stream, claudeQuery: unavailable }, clock: c.clock },
      cwd: "/p", executable: "codex", env: {} } as never);
    let closed = false;
    const first = agent.close().then(() => { closed = true; });
    void agent.close();
    await flush();
    if (deaf) {
      assert.deepEqual(p.ops, [["term", 0]]);
      await c.advance(4_999);
      assert.deepEqual(p.ops, [["term", 0]], "no SIGKILL before the grace period ends");
      assert.equal(closed, false, "close() waits for the provider");
      await c.advance(1);
    }
    await first;
    assert.deepEqual(p.ops, [["term", 0], ["kill", deaf ? 5_000 : 0]]);
    assert.equal(c.pending(), 0, "no timer left");
  });
}

test("Claude: close() ends the SDK's input, then SIGTERM to the provider's group, SIGKILL 5 s later", async () => {
  const c = steppedClock();
  const ops: [string, number][] = [];
  let gone = false;
  const goneFns: (() => void)[] = [];
  const query: ClaudeQuery = () => ({
    async *[Symbol.asyncIterator]() { await new Promise(() => undefined); },
    interrupt: async () => undefined,
    process: {
      terminate() { ops.push(["term", c.now()]); },
      kill() { ops.push(["kill", c.now()]); gone = true; for (const fn of goneFns) fn(); },
      onGone(fn: () => void) { if (gone) fn(); else goneFns.push(fn); },
    },
  });
  const agent = claudeAgent({ deps: { agents: { codex: unavailable, claudeQuery: query }, clock: c.clock },
    cwd: "/p" } as never);
  agent.turn(REQUEST as never, new AbortController().signal);
  const closing = agent.close();
  await flush();
  assert.deepEqual(ops, [["term", 0]]);
  await c.advance(4_999);
  assert.deepEqual(ops, [["term", 0]]);
  await c.advance(1);
  await closing;
  assert.deepEqual(ops, [["term", 0], ["kill", 5_000]]);
  await agent.close();
  assert.equal(ops.length, 2, "nothing more on a second close()");
});

test("the real primitive: POSIX signals the process group; Windows ends stdin only, then taskkill /T /F", () => {
  const calls: unknown[][] = [];
  const sys = (platform: NodeJS.Platform) => ({ platform, kill: (pid: number, sig: string) => { calls.push([pid, sig]); },
    taskkill: (pid: number) => { calls.push(["taskkill", pid]); } });
  const running = { pid: 4242, exitCode: null };
  signalGroup(running, "term", sys("darwin"));
  signalGroup(running, "kill", sys("linux"));
  signalGroup({ pid: 4242, exitCode: 0 }, "kill", sys("darwin"));
  assert.deepEqual(calls.splice(0), [[-4242, "SIGTERM"], [-4242, "SIGKILL"], [-4242, "SIGKILL"]],
    "the whole group, also after the leader exited (strays)");
  signalGroup(running, "term", sys("win32"));
  assert.deepEqual(calls.splice(0), [], "Windows: no signal is polite (TerminateProcess), so stdin's end is the ask");
  signalGroup(running, "kill", sys("win32"));
  signalGroup({ pid: 4242, exitCode: 1 }, "kill", sys("win32"));
  signalGroup({ exitCode: null }, "kill", sys("win32"));
  assert.deepEqual(calls.splice(0), [["taskkill", 4242]], "the tree while it runs; nothing once gone or never started");
  const throwing = { platform: "darwin" as const, kill: () => { throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }); },
    taskkill: () => undefined };
  assert.doesNotThrow(() => signalGroup(running, "kill", throwing), "an empty group is not an error");
});
