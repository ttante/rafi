// Item 18 (M4 plan 3.3, C132, C133, C136): the lease on a timer clock. Acquire on a fresh row; take over only when
// isAlive says dead and the row is unchanged (C15); a heartbeat every 10 s; "not responding" over 60 s with a live
// owner, and no takeover then; release only by the owner.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type { Cancel, Clock, Owner, Processes } from "../../src/deps/types.js";
import { openRealDb } from "../../src/deps/real/db.js";
import { openLog } from "../../src/log/db.js";
import {
  acquireLease, heartbeat, liveOwner, readLease, releaseLease, startHeartbeat, HEARTBEAT_MS,
} from "../../src/log/lease.js";
import { tempDir } from "../helpers.js";

function timerClock() {
  let now = Date.parse("2026-11-01T14:00:00Z");
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let id = 0;
  const clock: Clock = {
    now: () => new Date(now),
    timer(ms, fn): Cancel { const t = { at: now + ms, fn, id: ++id }; timers.push(t);
      return () => { timers = timers.filter((x) => x.id !== t.id); }; },
    async sleep(ms) { now += ms; },
  };
  const advance = async (ms: number) => {
    const target = now + ms;
    for (;;) {
      const next = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      timers = timers.filter((t) => t !== next);
      now = next.at;
      next.fn();
      await new Promise((r) => setImmediate(r));
    }
    now = target;
  };
  return { clock, advance };
}

const owner = (instance: string): Owner => ({ instance, host: "h", pid: 1, startedAt: null });
const procs = (self: string, alive: Set<string>): Processes => ({ self: () => owner(self),
  isAlive: async (o) => alive.has(o.instance) });

async function setup() {
  const { clock, advance } = timerClock();
  const log = await openLog({ db: { open: (f) => openRealDb(f) }, clock }, path.join(tempDir(), "s.sqlite3"));
  return { log, clock, advance };
}

test("acquire on a fresh row; a second instance can't take a live owner's lease, and can take a dead one's", async () => {
  const { log } = await setup();
  const alive = new Set(["a", "b"]);
  assert.deepEqual(await acquireLease(log, procs("a", alive), "r1"), { ok: true, previous: null });
  assert.equal(readLease(log, "r1")?.instance, "a");
  const refused = await acquireLease(log, procs("b", alive), "r1");
  assert.equal(refused.ok, false);
  alive.delete("a");
  const taken = await acquireLease(log, procs("b", alive), "r1");
  assert.equal(taken.ok, true);
  assert.equal((taken as { previous: { instance: string } }).previous.instance, "a");
  assert.equal(readLease(log, "r1")?.instance, "b");
});

test("C15: a takeover writes only if the row didn't change while isAlive was asked", async () => {
  const { log, clock } = await setup();
  await acquireLease(log, procs("a", new Set(["a"])), "r1");
  const racing: Processes = { self: () => owner("b"), isAlive: async () => {
    await clock.sleep(1000, "timeout");
    await heartbeat(log, procs("a", new Set()), "r1");
    return false;
  } };
  const out = await acquireLease(log, racing, "r1");
  assert.equal(out.ok, false);
  assert.equal(readLease(log, "r1")?.instance, "a");
});

test("C136: the owner's heartbeat refreshes the row every 10 s until it's cancelled", async () => {
  const { log, clock, advance } = await setup();
  const p = procs("a", new Set(["a"]));
  await acquireLease(log, p, "r1");
  const stop = startHeartbeat(log, p, clock, "r1");
  assert.equal(HEARTBEAT_MS, 10_000);
  await advance(25_000);
  assert.equal(readLease(log, "r1")?.heartbeat_at, "2026-11-01T14:00:20.000Z");
  stop();
  await advance(30_000);
  assert.equal(readLease(log, "r1")?.heartbeat_at, "2026-11-01T14:00:20.000Z");
});

test("C133: alive, dead, not responding over 60 s (still alive, so no takeover), and no row", async () => {
  const { log, advance } = await setup();
  const alive = new Set(["a"]);
  assert.equal(await liveOwner(log, procs("b", alive), "r1"), "none");
  await acquireLease(log, procs("a", alive), "r1");
  assert.equal(await liveOwner(log, procs("b", alive), "r1"), "alive");
  await advance(61_000);
  assert.equal(await liveOwner(log, procs("b", alive), "r1"), "not-responding");
  assert.equal((await acquireLease(log, procs("b", alive), "r1")).ok, false, "not responding isn't taken over");
  alive.delete("a");
  assert.equal(await liveOwner(log, procs("b", alive), "r1"), "dead");
});

test("release only by the owner", async () => {
  const { log } = await setup();
  await acquireLease(log, procs("a", new Set(["a"])), "r1");
  assert.equal(await releaseLease(log, procs("b", new Set(["a"])), "r1"), false);
  assert.equal(readLease(log, "r1")?.instance, "a");
  assert.equal(await releaseLease(log, procs("a", new Set(["a"])), "r1"), true);
  assert.equal(readLease(log, "r1"), null);
});

// M4 review, finding 4: the takeover's compare-and-swap compares the whole observed row, not just instance and
// heartbeat. Each field changes while isAlive is asked, with instance and heartbeat kept; the swap must refuse.
test("C15: a takeover refuses when any field of the row changed while isAlive was asked", async () => {
  for (const [field, value] of [["host", "h2"], ["pid", 2], ["started_at", "2026-11-01T13:00:00.000Z"]] as const) {
    const { log } = await setup();
    await acquireLease(log, procs("a", new Set(["a"])), "r1");
    const racing: Processes = { self: () => owner("b"), isAlive: async () => {
      log.db.prepare(`UPDATE lease SET ${field} = ? WHERE run_id = 'r1'`).run(value);
      return false;
    } };
    const out = await acquireLease(log, racing, "r1");
    assert.equal(out.ok, false, `${field} changed`);
    assert.equal(readLease(log, "r1")?.instance, "a", `${field} changed`);
    assert.equal(readLease(log, "r1")?.[field], value, `${field} changed`);
  }
});

// M4 review, findings 1 and 2: one live build per checkout (ARCH 8.5) is decided by the lease table as a whole.
test("one live build per checkout: a live owner of any run refuses a lease on another run", async () => {
  const { log } = await setup();
  const alive = new Set(["a", "b"]);
  await acquireLease(log, procs("a", alive), "r1");
  const refused = await acquireLease(log, procs("b", alive), "r2");
  assert.equal(refused.ok, false);
  assert.equal((refused as { owner: { run_id: string } }).owner.run_id, "r1");
  assert.equal(readLease(log, "r2"), null);
  alive.delete("a");
  assert.equal((await acquireLease(log, procs("b", alive), "r2")).ok, true, "a dead owner elsewhere doesn't block");
});

test("one live build per checkout: a takeover of another run while isAlive is asked fails the swap", async () => {
  const { log } = await setup();
  await acquireLease(log, procs("x", new Set(["x"])), "r0");
  // b checks the checkout (x is dead); before b's transaction, c takes r0 over and is alive.
  const alive = new Set(["c"]);
  let raced = false;
  const racing: Processes = { self: () => owner("b"), isAlive: async (o) => {
    if (!raced) {
      raced = true;
      assert.equal((await acquireLease(log, procs("c", alive), "r0")).ok, true);
    }
    return alive.has(o.instance);
  } };
  const out = await acquireLease(log, racing, "r1");
  assert.equal(raced, true, "b asked about r0's owner");
  assert.equal(out.ok, false);
  assert.equal(readLease(log, "r1"), null, "b took nothing");
  assert.equal(readLease(log, "r0")?.instance, "c");
});
