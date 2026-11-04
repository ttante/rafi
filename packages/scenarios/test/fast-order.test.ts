// C124: the fast suite runs its jobs longest first, from the last run's times, falling back to file size.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { order, readTimes, writeTimes } from "../harness/fast-order.mjs";
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
