// M4 review fixes 8 and 9: `rafi stop` writes what it decided only if the build didn't change meanwhile: through
// engine.own(null) with no live owner, else `writeSince` (the interleavings are forced in scenarios/test/race-m4).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Engine } from "../../src/api/engine.js";
import { stopUnowned } from "../../src/build/claim.js";
import type { LeaseRow } from "../../src/log/lease.js";

const row = (run: string): LeaseRow => ({ run_id: run, instance: "other", host: "h", pid: 2, started_at: "unknown",
  heartbeat_at: "2026-11-01T14:00:00.000Z" });
const owning = (result: { ok: true } | { ok: false; owner: LeaseRow | null }) => {
  const calls: unknown[] = [];
  const engine = { own: async (run: string | null, events: unknown, o: unknown) => {
    calls.push([run, events, o]);
    return result;
  } } as unknown as Engine;
  return { engine, calls };
};
const EVENTS = [{ type: "build.stop_requested", actor: "user", data: {} },
  { type: "build.stopped", actor: "engine", data: { cause: "stop" } }];

test("stopUnowned writes owning nothing, with the decision's since", async () => {
  const { engine, calls } = owning({ ok: true });
  assert.deepEqual(await stopUnowned(engine, "r1", EVENTS, 7),
    { code: 0, line: "Build r1 stopped. `rafi resume` continues it." });
  assert.deepEqual(calls, [[null, EVENTS, { since: 7 }]]);
});

test("stopUnowned decides again when the build changed or was taken over", async () => {
  assert.equal(await stopUnowned(owning({ ok: false, owner: null }).engine, "r1", EVENTS, 7), null);
  assert.equal(await stopUnowned(owning({ ok: false, owner: row("r1") }).engine, "r1", EVENTS, 7), null,
    "taken over: the next decision asks its new owner to stop");
});

test("stopUnowned leaves an older build alone while another build here is live", async () => {
  assert.deepEqual(await stopUnowned(owning({ ok: false, owner: row("r2") }).engine, "r1", EVENTS, 7),
    { code: 1, line: "Build r2 is running here (one live build per checkout); build r1 was left as it is." });
});
