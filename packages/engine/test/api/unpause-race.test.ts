// M4 review fix 10: `rafi resume` on a paused build with a live owner writes build.unpause_requested (C140). When the
// owner died and another `rafi resume` took the build over before that write landed, the request is out of date: it's
// not written and the caller decides again (it then follows the new owner). The interleaving is forced: the write's
// first BEGIN is busy, and the takeover runs in its backoff.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openEngine, type Engine } from "../../src/api/engine.js";
import { unpauseBuild } from "../../src/api/stop.js";
import type { Clock, Db, Deps } from "../../src/deps/types.js";
import { openRealDb } from "../../src/deps/real/db.js";
import { realFs } from "../../src/deps/real/fs.js";
import { standard } from "../../src/workflow/standard.js";
import { workflowDigest } from "../../src/workflow/load.js";
import { busyDb, manualClock, tempDir } from "../helpers.js";

function engine(dir: string, instance: string, o: { db?: (file: string) => Db; clock?: Clock } = {}): Promise<Engine> {
  let n = 0;
  const random = { id: () => `${instance}-${++n}`, jitter: () => 0 };
  const deps = { fs: realFs(random), db: { open: (f: string, opts?: { readonly?: boolean }) =>
    o.db ? o.db(f) : openRealDb(f, opts) }, clock: o.clock ?? manualClock(), random, env: {},
  hooks: { crash() {}, pause() {} },
  processes: { self: () => ({ instance, host: "h", pid: 1, startedAt: null }), isAlive: async () => false },
  } as unknown as Deps;
  return openEngine({ projectDir: dir, deps });
}

const acquired = (instance: string) => ({ type: "build.owner_acquired", run_id: "r1", actor: "engine",
  data: { instance, host: "h", pid: 1 } });

test("an unpause request decided before another resume took the paused build over isn't written", async () => {
  const dir = tempDir();
  const owner = await engine(dir, "x");
  await owner.append([{ type: "project.created", actor: "engine", data: { app_name: "a", rafi_version: "1" } },
    { type: "tickets.changed", actor: "engine", data: { by: "user", items: [{ ticket: "T1", field: "added" }],
      material: false } },
    { type: "build.started", run_id: "r1", actor: "user", data: { workflow: { id: standard.id,
      version: standard.version, digest: workflowDigest(standard) }, scope: { kind: "all", value: null, skip: [] },
    tickets: [], settings: {}, engine_version: "1", argv: [] } }]);
  assert.deepEqual(await owner.own("r1", [acquired("x")]), { ok: true });
  await owner.append([
    { type: "build.pause_requested", run_id: "r1", actor: "user", data: { source: "terminal", boundary: null } },
    { type: "build.paused", run_id: "r1", actor: "engine", data: { source: "engine", boundary: null } }]);
  // x has died; resume b takes the build over while resume a's unpause request waits on a busy database.
  const taker = await engine(dir, "b");
  let busy = true;
  const clock = manualClock();
  const viewer = await engine(dir, "a", { db: (f) => busyDb(f, () => busy), clock: { ...clock, sleep: async (ms) => {
    busy = false;
    await clock.sleep(ms, "backoff");
    const since = taker.buildSeq();
    assert.deepEqual(await taker.own("r1", [
      { type: "build.owner_lost", run_id: "r1", actor: "engine",
        data: { last_heartbeat_at: clock.now().toISOString() } },
      { type: "build.resumed", run_id: "r1", actor: "user",
        data: { from_state: "paused", ticket: null, settings: {} } },
      acquired("b")], { since }), { ok: true });
  } } });
  const said = await unpauseBuild(viewer, "r1", { actor: "user", source: "terminal" }, viewer.buildSeq());
  assert.equal(said, null, "decide again");
  const types = [];
  for await (const e of viewer.events()) types.push(e.type);
  assert.deepEqual(types.slice(-4), ["build.paused", "build.owner_lost", "build.resumed", "build.owner_acquired"],
    "no unpause request written");
  assert.equal(viewer.fold().builds.r1?.state, "running");
  for (const e of [owner, taker, viewer]) e.close();
});
