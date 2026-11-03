// Log tests (ARCH 14 M1 "Also"): append-only, cursor replay, idempotency, busy retry on the clock,
// migrations, the 64 KB limit, blobs by digest, the lease, validation on read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { append, InvalidEventError } from "../../src/log/append.js";
import { openLog, StorageError, userVersion } from "../../src/log/db.js";
import { getBlob, putBlob } from "../../src/log/blobs.js";
import { acquireLease, heartbeat, readLease, releaseLease } from "../../src/log/lease.js";
import { latestVersion, migrations } from "../../src/log/migrations/index.js";
import { readEvents } from "../../src/log/read.js";
import { openRealDb } from "../../src/deps/real/db.js";
import { busyDb, manualClock, processesFor, tempDir, testLog } from "../helpers.js";

const created = { type: "project.created", actor: "user", data: { app_name: "app", rafi_version: "1.0.0" } };
const tags = (n: number) => ({ type: "ticket.tags_added", ticket_id: "T1", actor: "engine",
  data: { tags: [{ tag: `t${n}`, reason: "r" }] } });

test("append-only: no update or delete API, rows unchanged after later appends", async () => {
  const { ctx, log } = await testLog();
  await append(ctx, [created]);
  const before = log.db.prepare("SELECT * FROM events").all();
  for (let i = 0; i < 5; i += 1) await append(ctx, [tags(i)]);
  const after = log.db.prepare("SELECT * FROM events WHERE seq <= 1").all();
  assert.deepEqual(after, before);
  const exported = Object.keys(await import("../../src/log/append.js"));
  assert.ok(!exported.some((name) => /update|delete|remove/i.test(name)));
});

test("replay from a cursor: exact order, resumes from any seq", async () => {
  const { ctx, log } = await testLog();
  await append(ctx, [created]);
  for (let i = 0; i < 6; i += 1) await append(ctx, [tags(i)]);
  const all = readEvents(log.db).events;
  assert.deepEqual(all.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7]);
  for (let from = 0; from <= 7; from += 1) {
    const page = readEvents(log.db, { from });
    assert.deepEqual(page.events.map((e) => e.seq), all.filter((e) => e.seq > from).map((e) => e.seq));
  }
  assert.equal(readEvents(log.db, { ticket: "T1" }).events.length, 6);
});

test("idempotency key: a second append writes nothing and returns the first result", async () => {
  const { ctx, log } = await testLog();
  const first = await append(ctx, [created, tags(1)], { idemKey: "answer-7" });
  const second = await append(ctx, [created, tags(1)], { idemKey: "answer-7" });
  assert.equal(second.replayed, true);
  assert.deepEqual(second.events.map((e) => e.id), first.events.map((e) => e.id));
  assert.equal(readEvents(log.db).events.length, 2);
});

test("invalid events and transitions throw and write nothing", async () => {
  const { ctx, log } = await testLog();
  await assert.rejects(append(ctx, [created, { type: "nope", actor: "user", data: {} }]), InvalidEventError);
  await assert.rejects(append(ctx, [{ ...created, data: { app_name: 3 } }]), InvalidEventError);
  const refusing = { ...ctx, checkTransition: () => "delivery.done isn't valid in queued" };
  await assert.rejects(append(refusing, [created]), /invalid transition/);
  assert.equal(readEvents(log.db).events.length, 0);
});

test("the 64 KB limit", async () => {
  const { ctx } = await testLog();
  const big = { type: "plan.failed", actor: "engine", data: { reason: "x".repeat(65 * 1024) } };
  await assert.rejects(append(ctx, [big]), /64 KB/);
});

test("busy retry on the fake clock: 5 s of busy succeeds; 31 s gives a storage error", async () => {
  for (const [busyMs, ok] of [[5_000, true], [31_000, false]] as const) {
    const clock = manualClock();
    const start = clock.now().getTime();
    const dir = tempDir();
    let opened = false;
    const { ctx } = await testLog({ dir, clock, db: (file) => busyDb(file, () => opened &&
      clock.now().getTime() - start < busyMs) });
    opened = true;
    const result = append(ctx, [created]);
    if (ok) {
      assert.equal((await result).events.length, 1);
      assert.ok(clock.slept.length > 1 && clock.slept.every((ms) => ms <= 1000), "backs off on the clock");
    } else {
      await assert.rejects(result, (error: unknown) => error instanceof StorageError);
      assert.ok(clock.now().getTime() - start >= 30_000);
    }
  }
});

test("migrations: fresh database reaches latest user_version; reopening runs none; no triggers", async () => {
  const { file, log, clock } = await testLog();
  assert.equal(userVersion(log.db), latestVersion);
  log.close();
  const again = await openLog({ db: { open: (f) => openRealDb(f) }, clock }, file);
  assert.equal(userVersion(again.db), latestVersion);
  assert.equal(String(again.db.pragma("journal_mode", { simple: true })), "wal");
  for (const migration of migrations) assert.doesNotMatch(migration.sql, /CREATE\s+TRIGGER/i);
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(dir, "../../src/log/migrations/001-initial.ts"), "utf8");
  assert.doesNotMatch(source, /CREATE\s+TRIGGER/i);
});

test("blobs by digest, bounded, redacted", async () => {
  const { ctx, log } = await testLog();
  const a = await putBlob(log, ctx.redact, "raw reply", { sensitive: false });
  const b = await putBlob(log, ctx.redact, "raw reply", { sensitive: false });
  assert.equal(a.digest, b.digest);
  assert.match(a.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(getBlob(log, a.digest)?.data, "raw reply");
  const secret = await putBlob(log, ctx.redact, "token=s3cr3t-value-123 ok", { sensitive: true });
  assert.doesNotMatch(getBlob(log, secret.digest)!.data, /s3cr3t/);
  assert.equal(getBlob(log, secret.digest)?.sensitive, true);
});

test("lease: acquire, refuse while alive, take over when dead, compare-and-swap under a race", async () => {
  const { log } = await testLog();
  const dead = new Set<string>();
  const alive = (instance: string) => !dead.has(instance);
  const a = processesFor("A", alive);
  const b = processesFor("B", alive);
  assert.equal((await acquireLease(log, a, "r1")).ok, true);
  assert.equal((await acquireLease(log, b, "r1")).ok, false);
  assert.equal(await heartbeat(log, a, "r1"), true);
  dead.add("A");
  const c = processesFor("C", alive);
  const [first, second] = await Promise.all([acquireLease(log, b, "r1"), acquireLease(log, c, "r1")]);
  assert.equal([first.ok, second.ok].filter(Boolean).length, 1, "exactly one takes over");
  const owner = readLease(log, "r1")!;
  assert.ok(owner.instance === "B" || owner.instance === "C");
  assert.equal(await heartbeat(log, a, "r1"), false, "the old owner lost it");
  assert.equal(await releaseLease(log, owner.instance === "B" ? b : c, "r1"), true);
  assert.equal(readLease(log, "r1"), null);
});

test("validated on read: bad JSON, unknown type, unknown v, failing schema, over 64 KB become violations", async () => {
  const { ctx, log } = await testLog();
  await append(ctx, [created]);
  const insert = log.db.prepare(`INSERT INTO events (id, type, v, class, at, actor, data)
    VALUES (?, ?, ?, 'state', '2026-11-01T14:00:00.000Z', 'user', ?)`);
  insert.run("x1", "project.created", 1, "{not json");
  insert.run("x2", "made.up", 1, "{}");
  insert.run("x3", "project.created", 9, JSON.stringify(created.data));
  insert.run("x4", "project.created", 1, JSON.stringify({ app_name: 1 }));
  insert.run("x5", "plan.failed", 1, JSON.stringify({ reason: "x".repeat(70_000) }));
  const read = readEvents(log.db);
  assert.equal(read.events.length, 1);
  assert.deepEqual(read.violations.map((v) => v.seq), [2, 3, 4, 5, 6]);
  assert.equal(read.cursor, 6);
});

test("imported events are read only when asked for", async () => {
  const { ctx, log } = await testLog();
  await append(ctx, [created]);
  log.db.prepare(`INSERT INTO events (id, type, v, class, at, actor, origin, data)
    VALUES ('imp', 'ticket.tags_added', 1, 'state', '2026-11-01T14:00:00.000Z', 'user', 'imported', ?)`)
    .run(JSON.stringify(tags(1).data));
  assert.equal(readEvents(log.db).events.length, 1);
  assert.equal(readEvents(log.db, { origin: "imported" }).events.length, 1);
  assert.equal(readEvents(log.db, { origin: "any" }).events.length, 2);
});

test("validated on write: a bad envelope field (actor, source, run or ticket id) throws and writes nothing", async () => {
  const { ctx, log } = await testLog();
  const bad = [
    { ...created, actor: "nobody" }, { ...created, actor: "" }, { ...created, source: "made-up" },
    { ...created, run_id: "" }, { ...tags(1), ticket_id: "" },
  ];
  for (const event of bad) await assert.rejects(append(ctx, [event]), InvalidEventError, JSON.stringify(event));
  assert.equal(readEvents(log.db).events.length, 0);
});

test("validated on read: a bad envelope field becomes a violation and is never folded", async () => {
  const { ctx, log } = await testLog();
  await append(ctx, [created]);
  const insert = log.db.prepare(`INSERT INTO events (id, run_id, ticket_id, type, v, class, at, actor, source, data)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`);
  const at = "2026-11-01T14:00:00.000Z";
  const data = JSON.stringify(tags(1).data);
  insert.run("e1", null, "T1", "ticket.tags_added", "state", at, "nobody", null, data);
  insert.run("e2", null, "T1", "ticket.tags_added", "state", at, "user", "made-up", data);
  insert.run("e3", null, "T1", "ticket.tags_added", "state", "yesterday", "user", null, data);
  insert.run("e4", null, "T1", "ticket.tags_added", "detail", at, "user", null, data);
  insert.run("", null, "T1", "ticket.tags_added", "state", at, "user", null, data);
  insert.run("e6", "", "T1", "ticket.tags_added", "state", at, "user", null, data);
  const read = readEvents(log.db);
  assert.deepEqual(read.events.map((e) => e.seq), [1]);
  assert.deepEqual(read.violations.map((v) => v.seq), [2, 3, 4, 5, 6, 7]);
  assert.match(read.violations[0]!.reason, /actor/);
  assert.match(read.violations[3]!.reason, /class/);
});

test("validated on read: an idempotent replay refuses a stored row that fails validation", async () => {
  const { ctx, log } = await testLog();
  await append(ctx, [created], { idemKey: "k1" });
  log.db.prepare("UPDATE events SET actor = 'nobody' WHERE idem_key = 'k1'").run();
  await assert.rejects(append(ctx, [created], { idemKey: "k1" }), /actor/);
});

test("an event whose data names its ticket: ticket_id defaults to it and must match it", async () => {
  const { ctx, log } = await testLog();
  const added = { type: "ticket.added", actor: "engine",
    data: { ticket: "T9", source: "ci", requirements: ["fix it"], hint: null } };
  const [stored] = (await append(ctx, [added])).events;
  assert.equal(stored!.ticket_id, "T9");
  assert.equal(readEvents(log.db, { ticket: "T9" }).events.length, 1);
  await assert.rejects(append(ctx, [{ ...added, ticket_id: "T1" }]), /T9/);
  const recheck = { type: "recheck.requested", actor: "engine", ticket_id: "T2",
    data: { ticket: "T3", revision: 1 } };
  await assert.rejects(append(ctx, [recheck]), /T3/);
  assert.equal(readEvents(log.db).events.length, 1);
});
