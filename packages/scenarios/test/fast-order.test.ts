// Milestone: M3
// C124: the fast suite runs its jobs longest first, from the last run's times, falling back to file size.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { order, pack, readTimes, writeTimes } from "../harness/fast-order.mjs";
import { madeTemp } from "../harness/temp.js";

const job = (name: string) => ({ name });

test("the longest recorded job goes first", () => {
  const out = order([job("a"), job("b"), job("c")], { a: 1000, b: 9000, c: 4000 }, () => 0);
  assert.deepEqual(out.map((j: { name: string }) => j.name), ["b", "c", "a"]);
});

test("with no recorded times, the biggest file goes first", () => {
  const sizes: Record<string, number> = { a: 10, b: 300, c: 20 };
  const out = order([job("a"), job("b"), job("c")], {}, (name: string) => sizes[name] ?? 0);
  assert.deepEqual(out.map((j: { name: string }) => j.name), ["b", "c", "a"]);
});

test("jobs with no recorded time go first, by size; recorded names that aren't jobs are ignored", () => {
  const sizes: Record<string, number> = { new1: 5, new2: 50 };
  const out = order([job("old"), job("new1"), job("new2")], { old: 30_000, gone: 99_000 },
    (name: string) => sizes[name] ?? 0);
  assert.deepEqual(out.map((j: { name: string }) => j.name), ["new2", "new1", "old"]);
});

test("times round-trip through the cache file; a missing or broken file reads as no times", () => {
  const dir = madeTemp("rafi-fast-order-");
  const file = path.join(dir, "deep", "times.json");
  assert.deepEqual(readTimes(file), {});
  writeTimes(file, [{ name: "x", ms: 12.5 }]);
  assert.deepEqual(readTimes(file), { x: 12.5 });
  writeFileSync(file, "{not json");
  assert.deepEqual(readTimes(file), {});
});

test("M5 speed: light files share a process up to the group limit; heavy and unknown files run alone; times are " +
  "kept for files that ran in a group", () => {
  const files = ["a", "b", "c", "d", "e", "f"];
  const times = { a: 500, b: 2500, c: 1500, d: 9000, e: 1000 };
  const out = pack(files, times, { solo: 3000, group: 4000 });
  assert.deepEqual(out, [["f"], ["d"], ["b", "c"], ["e", "a"]], "first fit, longest first; f is unknown");
  const file = path.join(madeTemp("rafi-order-"), "times.json");
  writeFileSync(file, JSON.stringify({ a: 500, gone: 1 }));
  writeTimes(file, [{ name: "group: b, e", ms: 3600 }], readTimes(file));
  assert.deepEqual(readTimes(file), { a: 500, gone: 1, "group: b, e": 3600 });
});
