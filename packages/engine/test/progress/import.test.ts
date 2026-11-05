// M5 P49 (item 33's owned cases; ARCH 3.7 `:413`, C224): the progress file read into a fresh or older database.
// An `owned` entry for a ticket the database doesn't have comes back rafi-owned (`ticket.added`, then
// `progress.imported`, one append); one with the same identity imports only its status; one whose id this database
// uses for a different fix ticket arrives under the next free FIX-<n>, with one line. Older entries aren't imported.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import { openEngine, type Engine } from "../../src/api/engine.js";
import type { Deps } from "../../src/deps/types.js";
import { openRealDb } from "../../src/deps/real/db.js";
import { realFs } from "../../src/deps/real/fs.js";
import { importProgress } from "../../src/progress/import.js";
import { writeProgress } from "../../src/progress/write.js";
import { manualClock, tempDir } from "../helpers.js";

const owned = (hint: string) => ({ source: "ci", requirements: ["suite/x.test"], hint, unit: null });

async function engineWith(file: unknown): Promise<Engine> {
  const dir = tempDir();
  mkdirSync(path.join(dir, ".rafi"), { recursive: true });
  writeFileSync(path.join(dir, ".rafi", "progress.yaml"), stringify(file));
  let n = 0;
  const random = { id: () => `id-${++n}`, jitter: () => 0 };
  const deps = { fs: realFs(random), db: { open: (f: string, o?: { readonly?: boolean }) => openRealDb(f, o) },
    clock: manualClock(), random, env: {}, hooks: { crash() {}, pause() {} },
    git: async () => ({ code: 128, stdout: "", stderr: "fatal: not a git repository" }),
    machine: { stateDir: tempDir(), host: "h", platform: process.platform },
    processes: { self: () => ({ instance: "m", host: "h", pid: 1, startedAt: null }), isAlive: async () => true },
  } as unknown as Deps;
  return openEngine({ projectDir: dir, deps });
}

const progress = (tickets: Record<string, unknown>) => ({ version: 1, tickets, questions: {}, answers: {} });
async function all(engine: Engine) {
  const out = [];
  for await (const e of engine.events()) out.push(e);
  return out;
}

test("a fresh database: the file's tickets imported; an owned one comes back rafi-owned, with its fix count", async () => {
  const engine = await engineWith(progress({
    T1: { status: "done", at: "2026-11-01T13:00:00Z" },
    "FIX-1": { status: "in_progress", at: "2026-11-01T13:30:00Z", step: "fixing·fix", fixes: 1, owned: owned("T2") },
    T9: { status: "done", at: "2026-11-01T13:00:00Z" },
  }));
  const lines: string[] = [];
  await importProgress(engine, ["T1", "T2"], (t) => lines.push(t));
  const events = await all(engine);
  assert.deepEqual(events.map((e) => [e.type, e.ticket_id]), [["ticket.added", "FIX-1"],
    ["progress.imported", "FIX-1"], ["progress.imported", "T1"]]);
  assert.ok(events.every((e) => e.source === "progress-file"));
  assert.deepEqual(events[0]!.data, { ticket: "FIX-1", source: "ci", requirements: ["suite/x.test"], hint: "T2",
    unit: null });
  const view = engine.fold([{ id: "T1", dependsOn: [] }, { id: "T2", dependsOn: [] }]);
  assert.deepEqual([view.tickets["FIX-1"]?.rafiOwned, view.tickets["FIX-1"]?.state, view.tickets["FIX-1"]?.fixesUsed],
    [true, "queued", 1]);
  assert.equal(view.tickets.T1?.state, "done");
  assert.equal(view.tickets.T9, undefined, "an unknown ticket is skipped");
  assert.ok(lines.includes("Rebuilt build state from .rafi/progress.yaml."), lines.join("\n"));
  assert.ok(lines.some((l) => /T9/.test(l)), "the skipped ticket is named");
  await importProgress(engine, ["T1", "T2"], () => undefined);
  assert.equal((await all(engine)).length, 3, "nothing newer the second time");
});

test("the same fix ticket imports only its status; a different one under the next free id, with one line", async () => {
  const engine = await engineWith(progress({}));
  await engine.append([{ type: "ticket.added", run_id: null, ticket_id: "FIX-1", actor: "engine",
    data: { ticket: "FIX-1", source: "ci", requirements: ["suite/x.test"], hint: "T2", unit: null } }]);
  const file = path.join(engine.projectDir, ".rafi", "progress.yaml");
  writeFileSync(file, stringify(progress({ "FIX-1": { status: "done", at: "2099-01-01T00:00:00Z",
    owned: owned("T2") } })));
  await importProgress(engine, [], () => undefined);
  assert.deepEqual((await all(engine)).slice(1).map((e) => [e.type, e.ticket_id]), [["progress.imported", "FIX-1"]]);
  writeFileSync(file, stringify(progress({ "FIX-1": { status: "planned", at: "2099-02-01T00:00:00Z",
    owned: { ...owned("T3"), requirements: ["suite/w.test"] } } })));
  const lines: string[] = [];
  await importProgress(engine, [], (t) => lines.push(t));
  const added = (await all(engine)).slice(2);
  assert.deepEqual(added.map((e) => [e.type, e.ticket_id]), [["ticket.added", "FIX-2"], ["progress.imported", "FIX-2"]]);
  assert.ok(lines.some((l) => /FIX-1/.test(l) && /FIX-2/.test(l)), lines.join("\n"));
  assert.equal(engine.fold().tickets["FIX-1"]?.state, "done", "this computer's FIX-1 keeps its own status");
});

test("a damaged or oversized file imports nothing: the database wins", async () => {
  const engine = await engineWith(progress({}));
  const file = path.join(engine.projectDir, ".rafi", "progress.yaml");
  writeFileSync(file, stringify(progress({ "FIX-1": { status: "done", at: "2026-11-01T13:00:00Z",
    owned: { ...owned("T2"), extra: 1 } } })));
  await importProgress(engine, [], () => undefined);
  writeFileSync(file, `${"#".repeat(1_100_000)}\n${stringify(progress({ T1: { status: "done",
    at: "2026-11-01T13:00:00Z" } }))}`);
  await importProgress(engine, ["T1"], () => undefined);
  assert.equal((await all(engine)).length, 0);
});

test("an entry the database already agrees with isn't imported again, however new its time", async () => {
  const engine = await engineWith(progress({ T1: { status: "planned", at: "2099-01-01T00:00:00Z" } }));
  await engine.append([{ type: "project.created", run_id: null, ticket_id: null, actor: "engine",
    data: { app_name: "a", rafi_version: "1" } }, { type: "tickets.populated", run_id: null, ticket_id: null,
    actor: "engine", data: { plan_rev: 1, added: ["T1"], retired: [], group: null } }]);
  const lines: string[] = [];
  await importProgress(engine, ["T1"], (t) => lines.push(t));
  assert.deepEqual((await all(engine)).map((e) => e.type), ["project.created", "tickets.populated"]);
  assert.deepEqual(lines, []);
});

// Item 33 (C225, S-PORT-2): a conflicted file is merged, written back clean in the progress file's lock, and the merged
// entries imported; one line per conflicting ticket. Q-PORT-2: a grant key in the file is refused and named.
const conflictText = (ours: unknown, theirs: unknown) =>
  `# Written by rafi\n<<<<<<< HEAD\n${stringify(ours)}=======\n${stringify(theirs)}>>>>>>> other\n`;

test("a conflicted file: merged per entry, written back clean, the newer entries imported, one line each", async () => {
  const engine = await engineWith(progress({}));
  const file = path.join(engine.projectDir, ".rafi", "progress.yaml");
  writeFileSync(file, conflictText(progress({ T1: { status: "done", at: "2026-11-01T14:10:00Z" },
    T3: { status: "planned", at: "1970-01-01T00:00:00.000Z" } }), progress({
    T1: { status: "planned", at: "1970-01-01T00:00:00.000Z" }, T3: { status: "done", at: "2026-11-01T13:58:00Z" } })));
  const lines: string[] = [];
  await importProgress(engine, ["T1", "T3"], (t) => lines.push(t));
  const clean = readFileSync(file, "utf8");
  assert.doesNotMatch(clean, /^(<{7}|={7}|>{7})/m, "written back clean");
  assert.deepEqual(Object.fromEntries(Object.entries((parse(clean) as { tickets: Record<string, { status: string }> })
    .tickets).map(([k, v]) => [k, v.status])), { T1: "done", T3: "done" });
  assert.deepEqual(lines.slice(0, 2), ["T1: kept ours (14:10 vs 00:00)", "T3: kept theirs (13:58 vs 00:00)"]);
  assert.deepEqual((await all(engine)).map((e) => e.ticket_id), ["T1", "T3"]);
  assert.ok(existsSync(path.join(engine.projectDir, ".rafi", "locks")), "written under the progress file's lock");
});

test("Q-PORT-2: a grant key in the file is refused and named; the rest is imported", async () => {
  const engine = await engineWith({ ...progress({ T1: { status: "done", at: "2026-11-01T13:00:00Z" } }),
    answers: { "grant|internet|T1": { at: "2026-11-01T13:00:00Z", choice: "allow", source: "terminal" } } });
  const lines: string[] = [];
  await importProgress(engine, ["T1"], (t) => lines.push(t));
  assert.ok(lines.some((l) => /grant\|internet\|T1/.test(l) && /stay on each computer/.test(l)), lines.join("\n"));
  assert.deepEqual((await all(engine)).map((e) => [e.type, e.ticket_id]), [["progress.imported", "T1"]]);
});

test("C300: a ticket this database never changed is written with the epoch, so a merge never prefers it", async () => {
  const engine = await engineWith(progress({}));
  await writeProgress(engine, engine.fold([{ id: "T1", dependsOn: [] }]));
  const written = parse(readFileSync(path.join(engine.projectDir, ".rafi", "progress.yaml"), "utf8")) as
    { tickets: Record<string, { at: string }> };
  assert.equal(written.tickets.T1?.at, "1970-01-01T00:00:00.000Z");
});
