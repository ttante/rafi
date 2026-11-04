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

test("requirements.written is v 2 and needs req_fps; every other type stays at v 1", () => {
  assert.equal(eventRegistry.get("requirements.written")?.v, 2);
  for (const [type, entry] of eventRegistry) if (type !== "requirements.written") assert.equal(entry.v, 1, type);
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
