// M5 plan item 24 (C184): the machine's org policy file. Missing means nothing locked; a valid file locks its keys;
// a damaged one (bad YAML, a wrong value, an unknown key) fails closed with one line naming the file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { realFs } from "../../src/deps/real/fs.js";
import { readPolicy } from "../../src/config/policy.js";
import { tempDir } from "../helpers.js";

const fs = realFs({ id: () => "x", jitter: () => 0 });

test("no policy file: nothing locked", async () => {
  assert.deepEqual(await readPolicy(fs, tempDir()), { ok: true, locked: {} });
});

test("a valid policy locks its keys; a damaged one fails closed naming the file", async () => {
  const dir = tempDir();
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "policy.yaml");
  writeFileSync(file, "version: 1\nlocked:\n  security.preset: sensitive\n");
  assert.deepEqual(await readPolicy(fs, dir), { ok: true, locked: { "security.preset": "sensitive" } });
  for (const text of ["version: 1\nlocked: [\n", "version: 1\nlocked:\n  security.preset: loose\n",
    "version: 1\nlocked:\n  nope: 1\n", "version: 2\n"]) {
    writeFileSync(file, text);
    const r = await readPolicy(fs, dir);
    assert.equal(r.ok, false, text);
    assert.match(r.ok ? "" : r.message, /policy\.yaml/);
    assert.match(r.ok ? "" : r.message, /refusing to start/);
  }
});
