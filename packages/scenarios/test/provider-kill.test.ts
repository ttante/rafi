// Milestone: M4
// M4 follow-up 2 (user decision): wherever rafi ends a provider (a build's end, a graceful stop, `rafi stop` twice,
// Ctrl+C, a turn timeout) it sends SIGTERM to the provider's process group, waits up to 5 s on the clock, then
// SIGKILLs the group. Here every provider ignores SIGTERM, so each one must get its SIGKILL exactly 5 s after its
// SIGTERM on the fake clock, and nothing else ends it.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ClaudeQuery, CodexSpawn, JsonRpcStream } from "@rafi-ai/engine";
import { B, on } from "../fakes/script/behaviors.js";
import type { Behavior } from "../fakes/script/engine.js";
import { configure, tempRoot } from "../fixtures/common.js";
import { fOne } from "../fixtures/f-one.js";
import { defaultAgents } from "../harness/agents.js";
import type { Computer } from "../harness/deps.js";
import { newComputer, rafiRunner } from "../harness/rafi.js";

type Runtime = "codex" | "claude";
interface End { readonly id: number; readonly op: "term" | "kill"; readonly at: number }
/** A turn rafi sent to provider `id` (Codex: a `turn/start`; Claude: a user message read from the prompt). */
interface Send { readonly id: number; readonly ended: boolean }

/** The default in-process providers, each made deaf to the polite step: only a kill ends it. */
function deafComputer(root: string): { computer: Computer; ends: End[]; sends: Send[] } {
  const base = newComputer(root);
  const ends: End[] = [];
  const sends: Send[] = [];
  const sent = (id: number) => sends.push({ id, ended: ends.some((e) => e.id === id) });
  let ids = 0;
  const at = () => base.clock.now().getTime();
  const fakeClock = base.clock.forInstance("fake-agents");
  const defaults = defaultAgents(base.script, base.serve,
    (ms, signal) => fakeClock.sleep(ms, "agent", signal).catch(() => undefined));
  const codex = (o: CodexSpawn): JsonRpcStream => {
    const id = ++ids;
    const inner = defaults.codex(o);
    return { ...inner, write: (message: unknown, meta?: unknown) => {
      if ((message as { method?: string }).method === "turn/start") sent(id);
      inner.write(message, meta);
    }, close: async () => { ends.push({ id, op: "term", at: at() }); },
      kill: () => { ends.push({ id, op: "kill", at: at() }); void inner.close(); } } as JsonRpcStream;
  };
  const claudeQuery: ClaudeQuery = (params) => {
    const id = ++ids;
    const prompt = (async function* () {
      for await (const message of params.prompt) { sent(id); yield message; }
    })();
    const inner = defaults.claudeQuery({ ...params, prompt });
    let gone = false;
    const goneFns: (() => void)[] = [];
    return Object.assign(inner, { process: {
      terminate: () => { ends.push({ id, op: "term", at: at() }); },
      kill: () => { ends.push({ id, op: "kill", at: at() }); gone = true; for (const fn of goneFns) fn(); },
      onGone: (fn: () => void) => { if (gone) fn(); else goneFns.push(fn); },
    } });
  };
  return { computer: { ...base, agents: { codex, claudeQuery } }, ends, sends };
}

function setup(runtime: Runtime, rule?: Behavior | ReturnType<typeof B.slow>) {
  const root = tempRoot();
  const project = fOne(root);
  configure(project, { harness: { targets: [runtime] } });
  const { computer, ends, sends } = deafComputer(root);
  if (rule) computer.script.rules.push(on("builder T1#1 @build", rule as Behavior));
  const rows = (sql: string) => {
    const db = new DatabaseSync(path.join(project, ".rafi", "state.sqlite3"), { readOnly: true });
    try { return db.prepare(sql).all() as Record<string, unknown>[]; } finally { db.close(); }
  };
  return { computer, ends, sends, rows, rafi: rafiRunner(computer, project) };
}

function eachKilledAfterGrace(ends: readonly End[]): void {
  assert.ok(ends.some((e) => e.op === "term"), "rafi ended at least one provider");
  for (const id of new Set(ends.map((e) => e.id))) {
    const mine = ends.filter((e) => e.id === id);
    assert.deepEqual(mine.map((e) => e.op), ["term", "kill"], `provider ${id}: one SIGTERM, then one SIGKILL`);
    assert.equal(mine[1]!.at - mine[0]!.at, 5_000, `provider ${id}: SIGKILL 5 s after SIGTERM on the clock`);
  }
}

for (const runtime of ["codex", "claude"] as const) {
  test(`${runtime}: the build's end, then a provider that ignores SIGTERM is killed after 5 s`, async () => {
    const s = setup(runtime);
    const r = await s.rafi("start . --steps 1");
    assert.equal(r.code, 0, r.output);
    eachKilledAfterGrace(s.ends);
  });

  test(`${runtime}: a graceful stop, rafi stop twice (now) and Ctrl+C each end it the same way`, async () => {
    for (const how of ["graceful", "now", "ctrl-c"] as const) {
      const s = setup(runtime, B.slow(10));
      const live = s.rafi.start("start . --steps 1", { tty: true });
      s.computer.clock.whenTimer("agent", async () => {
        if (how === "ctrl-c") return live.interrupt();
        await s.rafi("stop");
        if (how === "now") await s.rafi("stop");
      });
      const r = await live.done();
      assert.equal(r.code, how === "ctrl-c" ? 130 : 0, `${how}: ${r.output}`);
      eachKilledAfterGrace(s.ends);
    }
  });

  test(`${runtime}: a turn timeout whose cancel isn't taken ends the provider the same way`, async () => {
    // Only how the timed-out provider is ended is checked here, not how the retries go.
    const s = setup(runtime, { hang: true, ignoreCancel: true } as Behavior);
    const t0 = s.computer.clock.now().getTime();
    await s.rafi("start . --steps 1");
    eachKilledAfterGrace(s.ends);
    assert.ok(s.ends.some((e) => e.op === "term" && e.at - t0 === 30 * 60_000 + 30_000),
      `ended by the timeout (30 min idle, then 30 s to confirm): ${JSON.stringify(s.ends)}`);
  });

  test(`${runtime}: the retry after a timed-out turn rafi ended runs on a fresh agent`, async () => {
    // M4 follow-up 3, item 2: once rafi has ended the provider (the cancel was never confirmed), the retry gets a
    // fresh session: a new provider, sent the standing instructions again, as after a provider exit (ARCH 5.2).
    const s = setup(runtime, { hang: true, ignoreCancel: true } as Behavior);
    const r = await s.rafi("start . --steps 1");
    assert.equal(r.code, 0, r.output);
    assert.deepEqual(s.sends.filter((x) => x.ended), [], `no turn goes to a provider rafi ended: ${JSON.stringify(
      { sends: s.sends, ends: s.ends })}`);
    const intents = s.rows("SELECT data FROM events WHERE type = 'turn.intent' ORDER BY seq")
      .map((x) => JSON.parse(String(x.data)) as { key: string; attempt: number; instruction_chars: number });
    const retry = intents.find((i) => i.key === "T1:build:1" && i.attempt === 2);
    assert.ok(retry, `the build turn was retried: ${JSON.stringify(intents)}`);
    assert.ok(retry.instruction_chars > 0, "the retry's fresh session gets the standing instructions");
  });

  test(`${runtime}: SIGHUP (a closed terminal) or SIGTERM stops the build and ends its providers`, async () => {
    // M4 follow-up 3, item 3 (C183): no locked doc says what a lost terminal or a terminated rafi does, so it's a
    // graceful stop at once, then a stop now 5 s later (KILL_GRACE_MS) while the build is still going.
    for (const signal of ["SIGHUP", "SIGTERM"] as const) {
      const s = setup(runtime, B.slow(10));
      const live = s.rafi.start("start . --steps 1", { tty: true });
      s.computer.clock.whenTimer("agent", () => live.signal(signal));
      const r = await live.done();
      assert.equal(r.code, 0, `${signal}: ${r.output}`);
      const stops = s.rows("SELECT at, data FROM events WHERE type = 'build.stop_requested' ORDER BY seq")
        .map((x) => ({ at: Date.parse(String(x.at)), ...(JSON.parse(String(x.data)) as { mode: string }) }));
      assert.deepEqual(stops.map((x) => x.mode), ["graceful", "now"], `${signal}: ${JSON.stringify(stops)}`);
      assert.equal(stops[1]!.at - stops[0]!.at, 5_000, `${signal}: stop now 5 s after the graceful stop`);
      const stopped = s.rows("SELECT data FROM events WHERE type = 'build.stopped'")
        .map((x) => (JSON.parse(String(x.data)) as { cause: string }).cause);
      assert.deepEqual(stopped, ["cancel"], `${signal}: the turn was cancelled`);
      eachKilledAfterGrace(s.ends);
    }
  });
}
