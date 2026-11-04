// Item 22 (M4 plan 3.3, C153): Manager's three host commands. Parsing short and full ids; /pause writes
// build.pause_requested from Manager; /request-attempt answers an open "What next?" for the ticket with Retry, or
// writes only fix.granted when none is open; /answer-question with an unknown number exits 1, and on an answered
// one writes nothing and says who answered (C101). Each records actor and source `manager`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openEngine, type Engine } from "../../src/api/engine.js";
import type { Deps } from "../../src/deps/types.js";
import { openRealDb } from "../../src/deps/real/db.js";
import { realFs } from "../../src/deps/real/fs.js";
import { parseHost, runHost } from "../../src/manager/host.js";
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

const ok = (data: unknown) => data;
async function blockedOnWhatNext(e: Engine, open = true): Promise<void> {
  const ev = (type: string, data: unknown, ticket: string | null = "T1") =>
    ({ type, data, run_id: "run-7a", ticket_id: ticket, actor: "engine" });
  await e.append([{ type: "project.created", actor: "engine", data: { app_name: "a", rafi_version: "1" } },
    { type: "tickets.changed", actor: "engine", data: { by: "user", items: [{ ticket: "T1", field: "added" }],
      material: false } },
    ev("build.started", { workflow: { id: standard.id, version: standard.version, digest: workflowDigest(standard) },
      scope: { kind: "all", value: null, skip: [] }, tickets: [], settings: { "retries.fixes": { value: 0,
        source: "project" } }, engine_version: "1", argv: [] }, null),
    ev("ticket.started", { resume_step: null }),
    ev("requirements.written", ok({ path: "p", fp: "f", depth: "standard", depth_raised_from: null, count: 1,
      person_only: [], req_fps: ["r"] })),
    ev("builder.reported", { kind: "done", summary: "s", runs: [], block: null, question: null }),
    ev("checks.passed", { runs: [], reused: [] }),
    ev("verdict.recorded", { attempt: 1, results: [{ req: 1, status: "not-satisfied", runs: [], needs: null,
      note: "no" }], rejected: true, unverified: [], signature: "s", circling: false })]);
  if (open) {
    await e.append([{ type: "question.opened", run_id: "run-7a", actor: "engine", data: { id: "question-1", no: 1,
      kind: "what-next", tickets: ["T1"], text: "T1: What next?", options: [{ id: "retry", label: "Retry" }],
      recommended: "retry", context: null, urgency: "high", key: null } }]);
  }
}

const events = async (e: Engine) => { const out = []; for await (const x of e.events()) out.push(x); return out; };

test("parsing: the three commands, quoted reasons, and refusals in one line", () => {
  assert.deepEqual(parseHost("/pause run-7a T2"), { cmd: "pause", run: "run-7a", ticket: "T2" });
  assert.deepEqual(parseHost('/request-attempt run-7 T1 "one more try"'),
    { cmd: "request-attempt", run: "run-7", ticket: "T1", reason: "one more try" });
  assert.deepEqual(parseHost("/answer-question 3 retry"), { cmd: "answer-question", question: 3, choice: "retry" });
  for (const bad of ["/pause run-7", "/request-attempt r T1", "/answer-question x retry", "/report", "hello"]) {
    assert.ok("error" in parseHost(bad), bad);
  }
});

test("/pause with a short id writes build.pause_requested from Manager", async () => {
  const e = await engine();
  await blockedOnWhatNext(e, false);
  const out = await runHost(e, parseHost("/pause run-7 T1") as never);
  assert.equal(out.code, 0, out.line);
  const req = (await events(e)).filter((x) => x.type === "build.pause_requested");
  assert.deepEqual(req.map((x) => [x.actor, x.source, x.data]), [["manager", "manager",
    { source: "manager", boundary: null }]]);
  assert.equal((await runHost(e, parseHost("/pause nope T1") as never)).code, 1);
});

test("/request-attempt answers the open What next? with Retry, granted by Manager with the reason", async () => {
  const e = await engine();
  await blockedOnWhatNext(e);
  const out = await runHost(e, parseHost('/request-attempt run-7a T1 "one more try"') as never);
  assert.equal(out.code, 0, out.line);
  const all = await events(e);
  const answered = all.filter((x) => x.type === "question.answered");
  assert.deepEqual(answered.map((x) => [x.actor, x.source, (x.data as { choice: string }).choice]),
    [["manager", "manager", "retry"]]);
  const granted = all.filter((x) => x.type === "fix.granted");
  assert.deepEqual(granted.map((x) => [x.actor, x.source, x.data]), [["manager", "manager",
    { by: "manager", reason: "one more try" }]]);
  assert.equal(e.fold([{ id: "T1", dependsOn: [] }]).tickets.T1?.state, "queued");
});

test("/request-attempt with no open question writes only fix.granted", async () => {
  const e = await engine();
  await blockedOnWhatNext(e, false);
  const out = await runHost(e, parseHost('/request-attempt run-7a T1 "later"') as never);
  assert.equal(out.code, 0, out.line);
  const all = await events(e);
  assert.deepEqual(all.filter((x) => x.actor === "manager").map((x) => x.type), ["fix.granted"]);
});

test("/answer-question: unknown number exits 1; an answered one writes nothing and says who answered", async () => {
  const e = await engine();
  await blockedOnWhatNext(e);
  assert.equal((await runHost(e, parseHost("/answer-question 9 retry") as never)).code, 1);
  assert.equal((await runHost(e, parseHost("/answer-question 1 retry") as never)).code, 0);
  const count = (await events(e)).length;
  const again = await runHost(e, parseHost("/answer-question 1 retry") as never);
  assert.equal((await events(e)).length, count, "first answer wins");
  assert.match(again.line, /already answered by manager/);
});

// M4 review (C150, P38): every command that writes prunes completed interviews over 30 days old; Manager's host
// commands write, so they prune too (before their own write, as start, resume, stop and reset do).
test("C150: a host command prunes completed interviews over 30 days old, never unfinished ones", async () => {
  const e = await engine();
  await blockedOnWhatNext(e, false);
  const dir = path.join(e.projectDir, ".rafi", "interviews");
  mkdirSync(dir, { recursive: true });
  const record = (id: string, status: string, at: string, extra = {}) => JSON.stringify({ version: 1, id,
    workflow: "plan", status, title: id, created_at: at, updated_at: at, checkpoint: {}, ...extra });
  writeFileSync(path.join(dir, "old.json"), record("old", "completed", "2026-09-01T00:00:00.000Z",
    { completed_at: "2026-09-01T00:00:00.000Z" }));
  writeFileSync(path.join(dir, "open.json"), record("open", "paused", "2026-08-01T00:00:00.000Z"));
  const out = await runHost(e, parseHost('/request-attempt run-7a T1 "one more"') as never);
  assert.equal(out.code, 0, out.line);
  assert.deepEqual(readdirSync(dir).sort(), ["open.json"]);
});
