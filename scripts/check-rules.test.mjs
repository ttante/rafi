// check-rules.mjs's own tests: one planted violation per rule, a clean file that passes, and exemptions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFiles } from "./check-rules.mjs";

const E = "packages/engine/src/build/loop.ts";
const run = (path, text) => checkFiles([{ path, text }]).problems.map((p) => p.rule);
const lines = (n, line = "x;") => Array.from({ length: n }, () => line).join("\n");

test("a clean engine file passes", () => {
  const text = [
    'import path from "node:path";', 'import type { Deps } from "../deps/types.js";',
    "const LIMITS: readonly number[] = Object.freeze([1, 2]);", "const NAMES = Object.freeze({ a: 1 });",
    "const SET: ReadonlySet<string> = new Set([\"a\"]);", "const RE = /a\\/b/;",
    "export function where(deps: Deps, dir: string): string {", "  return path.join(dir, \"x\", String(LIMITS[0]));",
    "}", "export const at = (deps: Deps) => deps.clock.now();",
  ].join("\n");
  assert.deepEqual(run(E, text), []);
});

test("file over 500 lines, function over 100 lines, line over 120 characters", () => {
  assert.deepEqual(run(E, lines(501)), ["file-lines"]);
  assert.deepEqual(run(E, `function f() {\n${lines(100)}\n}`), ["function-lines"]);
  assert.deepEqual(run(E, `const s = "${"y".repeat(120)}";`), ["line-length"]);
  assert.deepEqual(run("packages/scenarios/harness/x.ts", lines(501)), ["file-lines"], "scenarios get size rules");
  assert.deepEqual(run("packages/scenarios/harness/x.ts", "let n = Date.now(); setTimeout(() => {}, 1);"), []);
});

test("time, timers, process, fs, child_process and database opens outside deps/real", () => {
  for (const [code, rule] of [
    ["const t = Date.now();", "banned-global"], ["const d = new Date();", "banned-global"],
    ["setTimeout(() => {}, 1);", "banned-global"], ["setInterval(() => {}, 1);", "banned-global"],
    ["const e = process.env.HOME;", "banned-global"], ["process.exit(1);", "banned-global"],
    ['import fs from "node:fs";', "banned-import"], ['import { spawn } from "child_process";', "banned-import"],
    ['import Database from "better-sqlite3";', "banned-import"],
    ['const r = await fetch("https://x");', "banned-global"], ['await globalThis.fetch("https://x");', "banned-global"],
  ]) {
    assert.deepEqual(run(E, code), [rule], code);
    assert.deepEqual(run("packages/engine/src/deps/real/clock.ts", code), [], `${code} in deps/real`);
  }
  assert.deepEqual(run("packages/rafi/src/next/commands/x.ts", "const t = Date.now();"), ["banned-global"]);
  assert.deepEqual(run("packages/rafi/src/next/deps.ts", 'import fs from "node:fs";'), []);
  assert.deepEqual(run(E, 'const d = new Date("2026-11-01");'), [], "new Date(x) is a parse, not a read");
  assert.deepEqual(run(E, 'await deps.fetch("https://x", {});'), [], "the fetch seam is the way (P47)");
});

test("module-level mutable state", () => {
  assert.deepEqual(run(E, "let count = 0;"), ["module-state"]);
  assert.deepEqual(run(E, "const cache = new Map();"), ["module-state"]);
  assert.deepEqual(run(E, "const list = [1, 2];"), ["module-state"]);
  assert.deepEqual(run(E, "export const table = { a: 1 };"), ["module-state"]);
  assert.deepEqual(run(E, "function f() { let n = 0; const m = new Map(); return [n, m]; }"), []);
});

test("no CREATE TRIGGER in migrations", () => {
  assert.deepEqual(run("packages/engine/src/log/migrations/002-x.ts", 'export const sql = "CREATE TRIGGER t";'),
    ["migration-trigger"]);
});

test("engine never imports ai-foreman; state imports only types", () => {
  assert.deepEqual(run(E, 'import { x } from "ai-foreman/runtime.js";'), ["ai-foreman-import"]);
  assert.deepEqual(run("packages/rafi/src/next/cli.ts", 'import "ai-foreman";'), ["ai-foreman-import"]);
  const S = "packages/engine/src/state/fold.ts";
  assert.deepEqual(run(S, 'import { standard } from "../workflow/standard.js";'), ["state-imports"]);
  assert.deepEqual(run(S, 'import type { Workflow } from "../workflow/types.js";\nimport { nextTicket } from "./ticket.js";'), []);
});

test("Windows-safe: no hand-joined paths, no shell strings", () => {
  assert.deepEqual(run(E, "export const f = (dir: string) => `${dir}/state.sqlite3`;"), ["hand-joined-path"]);
  assert.deepEqual(run(E, 'export const f = (root: string) => root + "/x";'), ["hand-joined-path"]);
  assert.deepEqual(run(E, "export const f = (o: any) => o.spawn(\"x\", [], { shell: true });"), ["shell-string"]);
  assert.deepEqual(run(E, 'export const f = (deps: any) => deps.exec("bash", ["-c", "ls"], {});'), ["shell-string"]);
  assert.deepEqual(run(E, "export const f = (run: string) => `rafi resume --run ${run}`;"), [], "not a path");
});

test("a rules-allow comment exempts one line and is listed", () => {
  const result = checkFiles([{ path: E, text: "let n = 0; // rules-allow: counter for a test" }]);
  assert.deepEqual(result.problems, []);
  assert.equal(result.exemptions.length, 1);
  assert.match(result.exemptions[0].reason, /counter for a test/);
});
