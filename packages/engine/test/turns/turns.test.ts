// Items 20–22 (M2 plan 3.3): classification (ARCH 5.1–5.2), the one repair try (5.3), backoff, and the runner:
// intent → send → validate → repair → retry, idle timeout and cancel, boundaries 1–3, every retry message differs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { replySchemas } from "rafi-spec/v1";
import type { Agent, AgentEvent, TurnRequest } from "../../src/agents/types.js";
import type { Clock, TimerKind } from "../../src/deps/types.js";
import type { NewEvent } from "../../src/log/types.js";
import { backoffMs } from "../../src/turns/backoff.js";
import { classify } from "../../src/turns/classify.js";
import { acceptRepair, readReply, repairMessage } from "../../src/turns/repair.js";
import { runTurn, type TurnSpec } from "../../src/turns/runner.js";

test("classify: every terminal kind and provider code to its category; unknown is provider", () => {
  const cases: [AgentEvent | null, string][] = [
    [{ kind: "error", code: "transient", message: "x" }, "provider"],
    [{ kind: "error", code: "unknown", message: "x" }, "provider"],
    [{ kind: "error", code: "session-gone", message: "x" }, "provider"],
    [{ kind: "error", code: "quota", message: "x" }, "quota"],
    [{ kind: "error", code: "auth", message: "x" }, "auth"],
    [{ kind: "error", code: "configuration", message: "x" }, "environment"],
    [{ kind: "error", code: "unknown", message: "x", detail: "error_max_structured_output_retries" }, "content"],
    [{ kind: "exit", code: 70 }, "provider"],
    [{ kind: "idle-timeout" }, "timeout"],
    [{ kind: "cancelled", confirmed: true }, "cancelled"],
    [null, "provider"],
  ];
  for (const [event, category] of cases) assert.equal(classify(event), category, JSON.stringify(event));
});

const DONE = { kind: "done", summary: "s", runs: [], block: null, question: null };

test("readReply: structured, plain JSON, trailing content at byte n, cut off, and prose", () => {
  assert.deepEqual(readReply("", DONE), { kind: "ok", value: DONE });
  assert.deepEqual(readReply(JSON.stringify(DONE)), { kind: "ok", value: DONE });
  const json = JSON.stringify(DONE);
  const trailing = readReply(`${json}${" ".repeat(4412 - json.length)}trailing text`);
  assert.equal(trailing.kind, "format");
  assert.equal(trailing.kind === "format" && trailing.atByte, 4412);
  assert.deepEqual(trailing.kind === "format" && trailing.recovered, DONE);
  const cut = readReply(json.slice(0, json.indexOf('"block"') + 3));
  assert.equal(cut.kind, "format");
  assert.deepEqual(cut.kind === "format" && cut.recovered, { kind: "done", summary: "s", runs: [] });
  assert.equal(readReply("I finished the work.").kind, "content");
});

test("the repair template; accept only an unchanged resend; a cut-off reply may only fill what was lost", () => {
  assert.equal(repairMessage("Unexpected non-whitespace character after JSON", 4412),
    "Your last reply wasn't valid JSON: the parser's error is quoted below; the problem is at byte 4412.\n" +
    "```text\nUnexpected non-whitespace character after JSON\n```\nSend the same reply again as valid JSON in the " +
    "same format. Don't run tools, read files or change anything.");
  assert.deepEqual(acceptRepair(DONE, DONE), { accepted: true, why: null });
  const changed = acceptRepair(DONE, { ...DONE, summary: "other" });
  assert.equal(changed.accepted, false);
  assert.match(String(changed.why), /summary/);
  assert.equal(acceptRepair({ kind: "done", summary: "s", runs: [] }, DONE).accepted, true);
});

test("backoff: 10, 30, 90 s, each ±20% from deps.random", () => {
  assert.deepEqual([1, 2, 3].map((n) => backoffMs(n, 0)), [10_000, 30_000, 90_000]);
  assert.equal(backoffMs(1, 1), 12_000);
  assert.equal(backoffMs(3, -1), 72_000);
});

/** A clock whose timers fire on the next macrotask, time jumping to them; sleeps resolve the same way. */
function quickClock(): Clock & { slept: { ms: number; kind: TimerKind }[] } {
  let now = Date.parse("2026-11-01T14:00:00Z");
  const slept: { ms: number; kind: TimerKind }[] = [];
  const timer = (ms: number, fn: () => void) => {
    let live = true;
    setImmediate(() => { if (live) { now += ms; fn(); } });
    return () => { live = false; };
  };
  return { slept, now: () => new Date(now), timer,
    sleep: (ms, kind) => { slept.push({ ms, kind }); now += ms; return Promise.resolve(); } };
}

type Script = (request: TurnRequest, signal: AbortSignal) => AgentEvent[] | "hang";

function scriptedAgent(turns: Script[], log: { requests: TurnRequest[]; closed: number }): Agent {
  let i = 0;
  return {
    runtime: "codex",
    capabilities: () => ({ structuredReplies: true, exitCodes: true, resume: true, images: true,
      enforceableGrants: true, compaction: true, localServersWithoutInternet: false }),
    turn(request, signal) {
      log.requests.push(request);
      const script = turns[Math.min(i++, turns.length - 1)]!;
      return (async function* () {
        const out = script(request, signal);
        if (out !== "hang") { yield* out; return; }
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        yield { kind: "cancelled", confirmed: true } as AgentEvent;
      })();
    },
    async close() { log.closed += 1; },
  };
}

const reply = (value: unknown): AgentEvent[] => [{ kind: "usage", input: 10, output: 2, measured: true },
  { kind: "reply", text: typeof value === "string" ? value : JSON.stringify(value) }];
const spec: TurnSpec = { run: "r1", ticket: "T1", meta: { key: "T1:build:1", role: "builder", ticket: "T1",
  step: "build", attempt: 1 }, message: "Build T1.", schema: { name: "builder", json: replySchemas.builder.json },
  reply: "builder", grants: [], runtime: "codex", model: null, effort: null, fast: false, session: "new",
  tools: ["run_check"], redo: false, instructions: "Be careful." };

function harness(turns: Script[]) {
  const log = { requests: [] as TurnRequest[], closed: 0 };
  const events: NewEvent[] = [];
  const hooks: string[] = [];
  const clock = quickClock();
  const deps = { clock, hooks: { crash: (b: string) => { hooks.push(b); }, pause: () => undefined },
    random: { id: () => "x", jitter: () => 0 } };
  const io = { record: async (e: readonly NewEvent[]) => { events.push(...e); }, blob: async () => "sha256:raw" };
  const run = () => runTurn(deps, scriptedAgent(turns, log), spec, io,
    { retries: 3, idleMs: 30 * 60_000, quotaWaitHours: 6 });
  const types = () => events.map((e) => e.type);
  return { log, events, hooks, clock, run, types };
}

test("an ok reply: intent, sent and reply recorded; boundaries 1–3 named", async () => {
  const h = harness([() => reply(DONE)]);
  const out = await h.run();
  assert.equal(out.ok, true);
  assert.deepEqual(h.types(), ["turn.intent", "turn.sent", "turn.reply"]);
  assert.deepEqual(h.hooks.map((b) => b.split(":")[0]), ["1", "2", "3"]);
  const intent = h.events[0]!.data as Record<string, unknown>;
  assert.equal(intent.instruction_chars, "Be careful.".length);
  assert.equal(intent.schema, "builder");
});

test("a format error gets one repair in the same session, tools refused; an unchanged resend is accepted", async () => {
  const json = JSON.stringify(DONE);
  const h = harness([() => reply(`${json}${" ".repeat(4412 - json.length)}trailing`), () => reply(DONE)]);
  const out = await h.run();
  assert.equal(out.ok, true);
  assert.equal(h.log.requests.length, 2);
  assert.equal(h.log.requests[1]!.repair, true);
  assert.match(h.log.requests[1]!.message, /at byte 4412/);
  const repair = h.events.find((e) => e.type === "turn.repair")!.data as Record<string, unknown>;
  assert.deepEqual([repair.accepted, repair.at_byte], [true, 4412]);
  assert.equal((h.events.find((e) => e.type === "turn.reply")!.data as { outcome: string }).outcome, "format");
});

test("a changed resend is rejected and the turn is redone as a content retry with the error sent back", async () => {
  const json = JSON.stringify(DONE);
  const h = harness([() => reply(`${json}${" ".repeat(200 - json.length)}trailing`),
    () => reply({ ...DONE, summary: "changed" }), () => reply(DONE)]);
  const out = await h.run();
  assert.equal(out.ok, true);
  const repair = h.events.find((e) => e.type === "turn.repair")!.data as Record<string, unknown>;
  assert.equal(repair.accepted, false);
  const retry = h.log.requests[2]!;
  assert.equal(retry.repair, undefined);
  assert.match(retry.message, /summary/);
  assert.notEqual(retry.message, h.log.requests[0]!.message, "every retry changes its input (NEW-RTY-1)");
  assert.ok(h.types().includes("turn.retry"));
});

test("content errors are retried with the errors in plain words, never sent to repair", async () => {
  const h = harness([() => reply({ ...DONE, runs: "4" }), () => reply(DONE)]);
  assert.equal((await h.run()).ok, true);
  assert.ok(!h.log.requests.some((r) => r.repair));
  assert.match(h.log.requests[1]!.message, /runs/);
});

test("provider errors back off 10 s then 30 s on the clock; four in a row fail after 3 retries", async () => {
  const err = (): AgentEvent[] => [{ kind: "error", code: "transient", message: "overloaded" }];
  const twice = harness([err, err, () => reply(DONE)]);
  assert.equal((await twice.run()).ok, true);
  assert.deepEqual(twice.clock.slept, [{ ms: 10_000, kind: "backoff" }, { ms: 30_000, kind: "backoff" }]);
  const retries = twice.events.filter((e) => e.type === "turn.retry").map((e) => e.data as Record<string, unknown>);
  assert.deepEqual(retries.map((r) => [r.category, r.delay_ms, r.attempt]), [["provider", 10_000, 1],
    ["provider", 30_000, 2]]);
  assert.match(twice.log.requests[1]!.message, /Retry 1 of 3 after a provider error/);
  const four = harness([err]);
  const out = await four.run();
  assert.equal(out.ok, false);
  assert.equal(!out.ok && out.category, "provider");
  assert.equal(four.log.requests.length, 4);
});

test("idle timeout: the turn is cancelled, then retried telling the agent it timed out", async () => {
  const h = harness([() => "hang", () => reply(DONE)]);
  const out = await h.run();
  assert.equal(out.ok, true);
  assert.ok(h.types().includes("turn.cancelled"));
  const first = h.events.find((e) => e.type === "turn.reply")!.data as { outcome: string };
  assert.equal(first.outcome, "timeout");
  assert.match(h.log.requests[1]!.message, /timed out/);
});

test("an idle turn that never confirms the cancel is ended after 30 s: the provider is closed", async () => {
  const log = { requests: [] as TurnRequest[], closed: 0 };
  const stubborn: Agent = { ...scriptedAgent([], log), turn: () => (async function* () {
    await new Promise(() => undefined);
  })() as AsyncIterable<AgentEvent> };
  const events: NewEvent[] = [];
  const out = await runTurn({ clock: quickClock(), hooks: { crash: () => undefined, pause: () => undefined },
    random: { jitter: () => 0 } }, stubborn, spec,
  { record: async (e) => { events.push(...e); }, blob: async () => "b" }, { retries: 0, idleMs: 1000, quotaWaitHours: 6 });
  assert.equal(out.ok, false);
  assert.equal(log.closed, 1);
  assert.equal(!out.ok && out.category, "timeout");
});
