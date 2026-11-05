// Milestone: M4
// Temp folders (M4 plan 10.2 "Disk"): every kind of test removes the `rafi-*` folders it made once its process
// exits with all tests passed, and keeps them when one failed. Checked in a child process for the scenarios'
// tracker (fixtures, snapshots, the fixture cache, process-set projects) and for the engine tests' helper.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const tracker = fileURLToPath(new URL("../harness/temp.ts", import.meta.url));
const fixtures = fileURLToPath(new URL("../fixtures/common.ts", import.meta.url));
const cache = fileURLToPath(new URL("../harness/fixture-cache.ts", import.meta.url));
const engineHelpers = fileURLToPath(new URL("../../engine/test/helpers.ts", import.meta.url));

function child(code: string): string[] {
  const r = spawnSync(process.execPath, ["--conditions=source", "--import", "tsx", "--input-type=module", "-e", code],
    { encoding: "utf8" });
  return r.stdout.trim().split("\n").filter(Boolean);
}

const make = (exit: number) => `
  const { madeTemp } = await import(${JSON.stringify(tracker)});
  const { tempRoot, gitRepo } = await import(${JSON.stringify(fixtures)});
  const { cacheFolder } = await import(${JSON.stringify(cache)});
  const { tempDir } = await import(${JSON.stringify(engineHelpers)});
  const a = madeTemp("rafi-cleanup-");
  const b = tempRoot("rafi-cleanup-");
  gitRepo(b + "/p", { "a.txt": "a" });
  const c = tempDir("rafi-cleanup-");
  console.log(JSON.stringify([a, b, cacheFolder(), c]));
  process.exitCode = ${exit};`;

const dirsOf = (out: string[]) => JSON.parse(out.at(-1) ?? "[]") as string[];

test("a passing test process removes every temp folder it made, the fixture cache's included", () => {
  const dirs = dirsOf(child(make(0)));
  assert.equal(dirs.filter(Boolean).length, 4, dirs.join("\n"));
  for (const dir of dirs) assert.equal(existsSync(dir), false, `${dir} is still there`);
});

test("a failing test process keeps its temp folders for inspection", () => {
  const dirs = dirsOf(child(make(1)));
  assert.equal(dirs.filter(Boolean).length, 4, dirs.join("\n"));
  for (const dir of dirs) assert.equal(existsSync(dir), true, `${dir} was removed`);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
