// Item 20 (M4 plan 3.3, C150, FILE-31): saved interviews. Valid and invalid records (an invalid one is skipped and
// named); newest first; pruning completed records older than 30 days on the clock, never unfinished ones; discard
// by a unique prefix; an id with `/` or `..`, and a record that's a symlink out of `.rafi/interviews/`, are refused
// before anything is removed or read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { realFs } from "../../src/deps/real/fs.js";
import {
  discardInterview, findInterview, pruneInterviews, readInterviews, unfinishedInterviews,
} from "../../src/setup/interviews.js";
import { tempDir } from "../helpers.js";

const fs = realFs({ id: () => "x", jitter: () => 0 });
const record = (id: string, status: string, updated: string, extra: Record<string, unknown> = {}) => ({
  version: 1, id, workflow: "plan", status, title: `Interview ${id}`, created_at: updated, updated_at: updated,
  checkpoint: {}, ...extra });

function project(files: Record<string, unknown>): string {
  const dir = tempDir();
  const folder = path.join(dir, ".rafi", "interviews");
  mkdirSync(folder, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(path.join(folder, name), typeof value === "string" ? value : JSON.stringify(value));
  }
  return dir;
}

test("valid records are read, newest first; an invalid one is skipped and named; completed ones aren't unfinished",
  async () => {
    const dir = project({ "a.json": record("a", "in_progress", "2026-10-01T00:00:00.000Z"),
      "b.json": record("b", "paused", "2026-10-03T00:00:00.000Z"),
      "c.json": record("c", "completed", "2026-10-05T00:00:00.000Z", { completed_at: "2026-10-05T00:00:00.000Z" }),
      "bad.json": "{ not json", "odd.json": { ...record("odd", "in_progress", "2026-10-02T00:00:00.000Z"),
        extra: 1 } });
    const read = await readInterviews(fs, dir);
    assert.deepEqual(read.records.map((r) => r.id).sort(), ["a", "b", "c"]);
    assert.deepEqual(read.skipped.map((s) => s.file).sort(), ["bad.json", "odd.json"]);
    assert.deepEqual(unfinishedInterviews(read.records).map((r) => r.id), ["b", "a"]);
    assert.deepEqual(await readInterviews(fs, tempDir()), { records: [], skipped: [] }, "no folder: none");
  });

test("pruning removes completed records older than 30 days on the clock, never unfinished ones", async () => {
  const dir = project({ "old.json": record("old", "completed", "2026-09-01T00:00:00.000Z",
    { completed_at: "2026-09-30T23:00:00.000Z" }),
  "recent.json": record("recent", "completed", "2026-10-15T00:00:00.000Z", { completed_at: "2026-10-15T00:00:00.000Z" }),
  "stale.json": record("stale", "in_progress", "2026-08-01T00:00:00.000Z") });
  const removed = await pruneInterviews(fs, dir, new Date("2026-11-01T00:00:00.000Z"));
  assert.deepEqual(removed, ["old"]);
  assert.deepEqual((await readInterviews(fs, dir)).records.map((r) => r.id).sort(), ["recent", "stale"]);
});

test("discard by a unique prefix; an ambiguous or unknown prefix is refused and removes nothing", async () => {
  const dir = project({ "plan-1.json": record("plan-1", "paused", "2026-10-01T00:00:00.000Z"),
    "plan-2.json": record("plan-2", "paused", "2026-10-02T00:00:00.000Z") });
  const records = (await readInterviews(fs, dir)).records;
  assert.ok("message" in findInterview(records, "plan-"));
  assert.ok("message" in findInterview(records, "nope"));
  const out = await discardInterview(fs, dir, "plan-2");
  assert.equal(out.ok, true);
  assert.deepEqual((await readInterviews(fs, dir)).records.map((r) => r.id), ["plan-1"]);
});

test("an id with / or .., and a record that's a symlink out of the folder, are refused before any removal", async () => {
  const outside = path.join(tempDir(), "secret.json");
  writeFileSync(outside, JSON.stringify(record("evil", "in_progress", "2026-10-01T00:00:00.000Z")));
  const dir = project({});
  symlinkSync(outside, path.join(dir, ".rafi", "interviews", "evil.json"));
  const read = await readInterviews(fs, dir);
  assert.deepEqual(read.records, [], "a symlink out of the folder is never read");
  assert.deepEqual(read.skipped.map((s) => s.file), ["evil.json"]);
  for (const bad of ["../secret", "a/b", ".."]) {
    const out = await discardInterview(fs, dir, bad);
    assert.equal(out.ok, false, bad);
  }
  assert.equal(existsSync(outside), true);
});
