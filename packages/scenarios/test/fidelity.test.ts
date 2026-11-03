// Fidelity (ARCH 14 M1 "Also"): each fake's wire output is parsed by the real adapters. The in-process Codex
// stream and the Codex executable (through the real transport), and the in-process Claude query and the
// `claude` executable (through the real SDK query), each give the same AgentEvent sequence for one turn with a
// schema, activity, a tool event, usage, a permission request, and a cancel; `meta` never reaches the wire.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { claudeAgent, codexAgent, type AgentEvent, type TurnRequest } from "@rafi-ai/engine/agents";
import { realCodex } from "@rafi-ai/engine/deps/real";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeQuery } from "@rafi-ai/engine";
import { claudeQuery } from "../fakes/claude/query.js";
import { codexStream } from "../fakes/codex/stream.js";
import { scriptEngine, type Behavior } from "../fakes/script/engine.js";
import { writeShims } from "../fakes/shims.js";
import { tempRoot } from "../fixtures/common.js";

const schema = { name: "builder", json: { type: "object", properties: { kind: { type: "string" },
  summary: { type: "string" } }, required: ["kind", "summary"], additionalProperties: false } };
const request = (attempt: number): TurnRequest => ({ meta: { key: `T1:build:${attempt}`, role: "builder",
  ticket: "T1", step: "build", attempt }, message: "Build T1.", schema, grants: [], tools: [] });
const turns: Behavior[] = [
  { activity: "working on T1", bash: "npm test", reply: { kind: "done", summary: "ok" } },
  { hang: true },
];
const unavailable = (() => { throw new Error("unused"); }) as never;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** How many turns a fake executable has logged as started. */
const loggedTurns = (log: string) => () =>
  (existsSync(log) ? readFileSync(log, "utf8").match(/"op":"turn"/g)?.length ?? 0 : 0);

/** Aborts once the fake has seen the new turn: polled, so a slow machine can't send the abort before the turn. */
async function abortOnceStarted(controller: AbortController, turnsSeen: () => number) {
  const before = turnsSeen();
  for (let waited = 0; turnsSeen() === before && waited < 30_000; waited += 10) await sleep(10);
  await sleep(50);
  controller.abort();
}

async function collect(agent: { turn(r: TurnRequest, s: AbortSignal): AsyncIterable<AgentEvent> }, attempt: number,
  cancelOnceStarted?: () => number) {
  const controller = new AbortController();
  const events: unknown[] = [];
  if (cancelOnceStarted) void abortOnceStarted(controller, cancelOnceStarted);
  for await (const event of agent.turn(request(attempt), controller.signal)) {
    if (event.kind === "permission") {
      events.push({ kind: "permission", request: event.request });
      event.decide("allow");
    } else {
      events.push(event);
    }
  }
  return events;
}

const kinds = (events: unknown[]) => events.map((e) => (e as { kind: string }).kind);

test("Codex: the in-process stream and the executable give the same events under the real adapter",
  { skip: process.platform === "win32" ? "spawning a PATH shim without a shell isn't possible on Windows" : false },
  async () => {
    const dir = tempRoot("rafi-fidelity-");
    const engine = scriptEngine(turns.map((behavior, i) => ({ selector: { role: "builder", attempt: i + 1 },
      behavior })));
    const fake = codexStream((meta) => engine.next(meta));
    const inProcess = codexAgent({ deps: { agents: { codex: () => fake.stream, claudeQuery: unavailable } },
      cwd: dir, executable: "codex", env: {} });
    const shims = writeShims(dir, { codex: turns, claude: turns });
    const exe = codexAgent({ deps: { agents: { codex: realCodex, claudeQuery: unavailable } }, cwd: dir,
      executable: shims.codex, env: { PATH: process.env.PATH } });
    const a = await collect(inProcess, 1);
    const b = await collect(exe, 1);
    assert.deepEqual(a, b);
    assert.deepEqual(kinds(a), ["activity", "permission", "tool", "usage", "reply"]);
    assert.deepEqual((a.at(-1) as { structured: unknown }).structured, { kind: "done", summary: "ok" });
    assert.deepEqual(await collect(inProcess, 2, () => fake.record.metas.length),
      [{ kind: "cancelled", confirmed: true }]);
    assert.deepEqual(await collect(exe, 2, loggedTurns(shims.logs.codex)),
      [{ kind: "cancelled", confirmed: true }]);
    assert.equal(fake.record.metas.length >= 2, true, "the in-process fake read meta beside the message");
    assert.doesNotMatch(JSON.stringify(fake.record.wire), /T1:build|"meta"/, "meta never reaches the wire");
    const log = readFileSync(shims.logs.codex, "utf8");
    assert.doesNotMatch(log, /T1:build|"meta"/);
    await inProcess.close();
    await exe.close();
  });

test("Claude: the in-process query and the claude executable give the same events under the real adapter",
  async () => {
    const dir = tempRoot("rafi-fidelity-");
    const engine = scriptEngine(turns.map((behavior, i) => ({ selector: { role: "builder", attempt: i + 1 },
      behavior })));
    const record = { metas: [] as unknown[], wire: [] as unknown[] };
    const inProcess = claudeAgent({ deps: { agents: { codex: unavailable,
      claudeQuery: claudeQuery((meta) => engine.next(meta), record) } }, cwd: dir });
    const shims = writeShims(dir, { codex: turns, claude: turns });
    const exe = claudeAgent({ deps: { agents: { codex: unavailable, claudeQuery: sdkQuery as unknown as ClaudeQuery } },
      cwd: dir, executable: shims.claudeEntry });
    const a = await collect(inProcess, 1);
    const b = await collect(exe, 1);
    assert.deepEqual(a, b);
    assert.deepEqual(kinds(a), ["activity", "permission", "tool", "usage", "reply"]);
    assert.deepEqual((a.at(-1) as { structured: unknown }).structured, { kind: "done", summary: "ok" });
    const cancelledHere = await collect(inProcess, 2, () => record.metas.length);
    assert.deepEqual(cancelledHere, await collect(exe, 2, loggedTurns(shims.logs.claude)));
    assert.deepEqual(cancelledHere.at(-1), { kind: "cancelled", confirmed: true });
    assert.equal(record.metas.filter(Boolean).length, 2, "the in-process fake read meta from the Symbol key");
    assert.doesNotMatch(JSON.stringify(record.wire), /T1:build|"meta"/, "meta never reaches the wire");
    assert.doesNotMatch(readFileSync(shims.logs.claude, "utf8"), /T1:build|"meta"/);
    await inProcess.close();
    await exe.close();
  });
