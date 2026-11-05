// M5 plan item 28: the tickets port's own unit tests, on a temp project and a real log. The four validation passes,
// queue order, the renderer's Next up and version line, a status command's event, the definitions writer (C210:
// comments kept, one record, none when already recorded), change items, groups and their snapshots, reset scopes,
// risk notes and setup writes (no token value saved, a source flag replaces the sources). The file lock's own tests
// are test/config/lock.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { openEngine, type Engine } from "../../src/api/engine.js";
import type { Deps } from "../../src/deps/types.js";
import { openRealDb } from "../../src/deps/real/db.js";
import { realFs } from "../../src/deps/real/fs.js";
import { changeItems, isMaterial, recordChange } from "../../src/tickets/changes.js";
import { reorderTicket } from "../../src/tickets/edit.js";
import { groupEvent, groups, memberDefinition, repairGroups } from "../../src/tickets/groups.js";
import { fileDigest, loadTickets } from "../../src/tickets/load.js";
import { renderProgressDoc } from "../../src/tickets/render.js";
import { applyReset, previewReset } from "../../src/tickets/reset.js";
import { riskGaps, waiveRiskNotes } from "../../src/tickets/risk.js";
import { setupTickets } from "../../src/tickets/setup.js";
import { setTicketStatus } from "../../src/tickets/status.js";
import { queueRows, validateTickets, VALIDATION_PASSED } from "../../src/tickets/validate.js";
import { manualClock, tempDir } from "../helpers.js";

const who = { actor: "user", source: "flag" as const };
const ticket = (n: number, more: Record<string, unknown> = {}) => ({ id: `T${n}`, order: n, title: `Ticket ${n}`,
  risk: "Low", acceptance: [`Ticket ${n} works.`], depends_on: n === 3 ? ["T1"] : [], ...more });

async function project(tickets = [1, 2, 3].map((n) => ticket(n))): Promise<{ engine: Engine; dir: string }> {
  const dir = tempDir();
  writeFileSync(path.join(dir, "rafi-config.yaml"), "# keep me\nformat_version: 1\nappName: demo\n");
  const file = path.join(dir, ".tickets", "tickets.yaml");
  await realFs({ id: () => "x", jitter: () => 0 }).writeAtomic(file, `# a comment\n${stringify({ tickets })}`);
  let n = 0;
  const random = { id: () => `id-${++n}`, jitter: () => 0 };
  const deps = { fs: realFs(random), db: { open: (f: string, o?: { readonly?: boolean }) => openRealDb(f, o) },
    clock: manualClock(), random, env: { LINEAR_API_KEY: "lin-secret" }, hooks: { crash() {}, pause() {} },
    machine: { stateDir: tempDir(), host: "h", platform: process.platform },
    fetch: async () => ({ status: 200, headers: {}, text: async () => "{}" }),
    processes: { self: () => ({ instance: "m", host: "h", pid: 1, startedAt: null }), isAlive: async () => true },
  } as unknown as Deps;
  return { engine: await openEngine({ projectDir: dir, deps }), dir };
}

test("validate: each pass names its problem; clean is the 1.0 line; the queue lists open tickets in order", async () => {
  const { engine } = await project([ticket(1), ticket(2, { depends_on: ["T9"] }), ticket(3, { risk: "High" })]);
  const problems = await validateTickets(engine, "docs");
  assert.ok(problems.some((p) => p.startsWith("[pass 1] T2 depends on T9")), problems.join("\n"));
  assert.ok(problems.some((p) => p.startsWith("[pass 2] T3 is High risk")), problems.join("\n"));
  assert.equal(VALIDATION_PASSED, "validation passed — all 4 passes clean");
  const view = engine.fold([1, 2, 3].map((n) => ({ id: `T${n}`, dependsOn: [] })));
  assert.deepEqual(queueRows(view).map((r) => r.id), ["T1", "T2", "T3"]);
  const doc = renderProgressDoc({ tickets: [], view, app: "a", now: "n" });
  assert.match(doc, /^## Next up$/m);
  assert.match(doc, /Written by rafi/);
});

test("a status command is one event with its actor; risk waivers clear the gap", async () => {
  const { engine } = await project([ticket(1, { risk: "Medium" }), ticket(2)]);
  assert.ok((await setTicketStatus(engine, "T2", { status: "blocked" }, who)).ok);
  assert.equal(engine.fold().tickets.T2?.state, "blocked");
  assert.deepEqual(await riskGaps(engine), [{ id: "T1", risk: "Medium", waived: false }]);
  assert.equal((await waiveRiskNotes(engine, ["T2"], "x", who)).ok, false, "T2 doesn't need one");
  assert.ok((await waiveRiskNotes(engine, undefined, "rolled back by hand", who)).ok);
  assert.deepEqual(await riskGaps(engine), [{ id: "T1", risk: "Medium", waived: true }]);
});

test("the definitions writer keeps comments, records once, and not at all when the content is recorded", async () => {
  const { engine, dir } = await project();
  const file = path.join(dir, ".tickets", "tickets.yaml");
  assert.ok((await reorderTicket(engine, "T3", { order: 1 }, who)).ok);
  assert.match(readFileSync(file, "utf8"), /^# a comment/);
  const loaded = await loadTickets(engine.deps.fs, dir);
  assert.ok(loaded.ok);
  assert.deepEqual(loaded.tickets.map((t) => t.id), ["T3", "T1", "T2"]);
  const digests = { digest: fileDigest(readFileSync(file, "utf8")), delivery_digest: null };
  assert.equal(await recordChange(engine, digests, [], who), "already");
  const items = changeItems({ tickets: [ticket(1), ticket(2)] as never, units: [] }, { tickets: [ticket(1,
    { title: "New" }), ticket(4)] as never, units: [] });
  assert.deepEqual(items, [{ ticket: "T1", field: "title" }, { ticket: "T4", field: "added" },
    { ticket: "T2", field: "removed" }]);
  assert.equal(isMaterial([{ ticket: "T1", field: "title" }]), false);
  assert.equal(isMaterial([{ ticket: "T1", field: "acceptance" }]), true);
});

test("groups keep each member's definition; reset scopes change only their tickets", async () => {
  const { engine } = await project();
  assert.ok((await repairGroups(engine, 3, who)).ok);
  const [g] = await groups(engine);
  assert.equal(g!.id, "TG-1");
  assert.equal(memberDefinition(engine, g!.members[1]!)?.title, "Ticket 2");
  assert.equal(((await groupEvent(engine, [], "repair", who)).data as { group: string }).group, "TG-2");
  await setTicketStatus(engine, "T1", { status: "done" }, who);
  await setTicketStatus(engine, "T2", { status: "canceled" }, who);
  const unfinished = await previewReset(engine, { scope: "unfinished" });
  assert.ok(!("message" in unfinished));
  assert.deepEqual(unfinished.tickets.map((t) => t.id), ["T3"]);
  const kept = await previewReset(engine, { scope: "completed-and-unfinished" });
  assert.deepEqual(!("message" in kept) && kept.tickets.map((t) => t.id), ["T1", "T3"]);
  const all = await previewReset(engine, { scope: "all" });
  assert.ok(!("message" in all));
  assert.ok((await applyReset(engine, all, { ...who, restore: false })).ok);
  assert.deepEqual([1, 2, 3].map((n) => engine.fold().tickets[`T${n}`]?.state), ["queued", "queued", "queued"]);
});

test("setup saves the variable's name, never the token; a source flag replaces the saved sources", async () => {
  const { engine, dir } = await project();
  const first = await setupTickets(engine, { sources: [{ type: "linear", api_key_env: "LINEAR_API_KEY" }] },
    { update: false, skipAccessCheck: false });
  assert.ok(first.ok, JSON.stringify(first));
  const text = readFileSync(path.join(dir, "rafi-config.yaml"), "utf8");
  assert.doesNotMatch(text, /lin-secret/);
  assert.match(text, /^# keep me/);
  assert.ok((await setupTickets(engine, { sources: [{ type: "url", url: "https://docs.example/x" }] },
    { update: true, skipAccessCheck: true })).ok);
  assert.doesNotMatch(readFileSync(path.join(dir, "rafi-config.yaml"), "utf8"), /linear/);
});
