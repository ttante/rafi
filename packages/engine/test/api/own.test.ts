// M4 review, finding 1 (ARCH 8.5): engine.own decides ownership inside its write transaction. Besides the lease table
// (log/lease.test.ts), a decision is out of date when a build event was written after it (`since`): own then writes
// nothing and returns no owner, so the caller decides again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openEngine, type Engine } from "../../src/api/engine.js";
import type { Deps } from "../../src/deps/types.js";
import { openRealDb } from "../../src/deps/real/db.js";
import { realFs } from "../../src/deps/real/fs.js";
import { standard } from "../../src/workflow/standard.js";
import { workflowDigest } from "../../src/workflow/load.js";
import { manualClock, tempDir } from "../helpers.js";

async function engine(): Promise<Engine> {
  let n = 0;
  const random = { id: () => `id-${++n}`, jitter: () => 0 };
  const deps = { fs: realFs(random), db: { open: (f: string, o?: { readonly?: boolean }) => openRealDb(f, o) },
    clock: manualClock(), random, env: {}, hooks: { crash() {}, pause() {} },
    processes: { self: () => ({ instance: "m", host: "h", pid: 1, startedAt: null }), isAlive: async () => false },
  } as unknown as Deps;
  return openEngine({ projectDir: tempDir(), deps });
}

const started = (run: string) => ({ type: "build.started", run_id: run, actor: "user", data: { workflow:
  { id: standard.id, version: standard.version, digest: workflowDigest(standard) }, scope: { kind: "all",
  value: null, skip: [] }, tickets: [], settings: {}, engine_version: "1", argv: [] } });
const acquired = (run: string) => ({ type: "build.owner_acquired", run_id: run, actor: "engine",
  data: { instance: "m", host: "h", pid: 1 } });

test("own refuses a decision made before a newer build event, writing nothing; a fresh one succeeds", async () => {
  const e = await engine();
  await e.append([{ type: "project.created", actor: "engine", data: { app_name: "a", rafi_version: "1" } },
    { type: "tickets.changed", actor: "engine", data: { by: "user", items: [{ ticket: "T1", field: "added" }],
      material: false } }]);
  const since = e.buildSeq();
  assert.equal(since, 0);
  await e.append([started("r1")]);
  const before = e.lastSeq();
  // Decided before r1 started (since 0): out of date.
  const stale = await e.own("r1", [acquired("r1")], { since });
  assert.deepEqual(stale, { ok: false, owner: null });
  assert.equal(e.lastSeq(), before, "nothing written");
  assert.equal(e.lease("r1"), null, "no lease taken");
  assert.deepEqual(await e.own("r1", [acquired("r1")], { since: e.buildSeq() }), { ok: true });
  assert.equal(e.lease("r1")?.instance, "m");
  e.close();
});
