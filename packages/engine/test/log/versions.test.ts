// Item 22 (M3 plan, C129): requirements.written moves to v 2 with req_fps; a v 1 row reads as one violation that
// names the version (ARCH 3.5: before 1.0 a breaking change bumps v and a development database is recreated).
import { test } from "node:test";
import assert from "node:assert/strict";
import { eventRegistry } from "rafi-spec/v1";
import { append } from "../../src/log/append.js";
import { readEvents } from "../../src/log/read.js";
import { testLog } from "../helpers.js";

const written = { path: "docs/requirements/T1.md", fp: "sha256:f", depth: "standard", depth_raised_from: null,
  count: 1, person_only: [], req_fps: ["sha256:r1"] };

// M4 (P35 C): turn.intent is v 2 too, with the turn's ticket, step and attempt.
const AT_V2: ReadonlySet<string> = new Set(["requirements.written", "turn.intent"]);

test("requirements.written and turn.intent are v 2; every other type stays at v 1", () => {
  for (const [type, entry] of eventRegistry) assert.equal(entry.v, AT_V2.has(type) ? 2 : 1, type);
});

const intent = { key: "T1:build:1", role: "builder", ticket: "T1", step: "build", attempt: 1, runtime: "codex",
  model: null, effort: null, fast: false, session: "new", schema: "builder", instruction_chars: 0,
  instruction_digest: `sha256:${"0".repeat(64)}`, tools: [], grants: [], redo: false };

test("a stored turn.intent v 1 row is one violation naming its version (M4, P35 C)", async () => {
  const { ctx, log } = await testLog();
  await append(ctx, [{ type: "turn.intent", ticket_id: "T1", actor: "engine", data: intent }]);
  assert.deepEqual(readEvents(log.db).violations, []);
  log.db.prepare("UPDATE events SET v = 1").run();
  assert.deepEqual(readEvents(log.db).violations.map((v) => v.reason), ["unknown version 1 of turn.intent"]);
});

test("a stored v 1 row is one violation naming the version; a v 2 row with req_fps reads back", async () => {
  const { ctx, log } = await testLog();
  await append(ctx, [{ type: "requirements.written", ticket_id: "T1", actor: "engine", data: written }]);
  const ok = readEvents(log.db);
  assert.deepEqual(ok.violations, []);
  assert.deepEqual((ok.events[0]!.data as { req_fps: string[] }).req_fps, ["sha256:r1"]);
  log.db.prepare("UPDATE events SET v = 1").run();
  const old = readEvents(log.db);
  assert.equal(old.events.length, 0);
  assert.deepEqual(old.violations.map((v) => v.reason), ["unknown version 1 of requirements.written"]);
});

test("a v 2 requirements.written without req_fps is refused on write, naming the field", async () => {
  const { ctx } = await testLog();
  const { req_fps: _drop, ...rest } = written;
  await assert.rejects(append(ctx, [{ type: "requirements.written", ticket_id: "T1", actor: "engine", data: rest }]),
    /req_fps/);
});
