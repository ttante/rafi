/**
 * Phase 3 — content loader. Reads the bundled rule packs / index / defaults that
 * the composition step consumes. Splits a pure `parseRulePack` (string → RulePack,
 * schema-validated) from the filesystem helpers so the parse rules are unit-tested
 * without disk, and the loaders are checked against the real bundled content.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  CONTENT_DIR,
  parseRulePack,
  loadDefaults,
  loadPacksIndex,
  loadAllPacks,
} from "../src/content.js";
import { validateRulePack } from "rafi-spec";

// ───────────────────────────── parseRulePack (pure) ─────────────────────────────

const SAMPLE = `---
name: sample
category: base
description: "A sample pack."
condition: always
template: false
---
## Sample

- A rule.
`;

test("parseRulePack returns validated front-matter + body", () => {
  const pack = parseRulePack(SAMPLE);
  assert.equal(pack.name, "sample");
  assert.equal(pack.category, "base");
  assert.equal(pack.condition, "always");
  assert.equal(pack.template, false);
  assert.equal(pack.body, "## Sample\n\n- A rule.\n");
  assert.ok(validateRulePack(pack).valid);
});

test("parseRulePack throws when front-matter is missing", () => {
  assert.throws(() => parseRulePack("## No front-matter\n- x"), /front-matter/i);
});

test("parseRulePack throws when front-matter fails schema validation", () => {
  const bad = `---
name: Bad_Name
category: nope
description: ""
condition: whenever
template: false
---
body`;
  assert.throws(() => parseRulePack(bad), /Invalid rule pack/i);
});

// ───────────────────────────── loaders (bundled content) ─────────────────────────────

test("CONTENT_DIR points at the bundled content directory", () => {
  assert.ok(existsSync(CONTENT_DIR), `CONTENT_DIR does not exist: ${CONTENT_DIR}`);
  assert.ok(existsSync(join(CONTENT_DIR, "rules", "packs.index.yaml")));
  assert.ok(existsSync(join(CONTENT_DIR, "defaults.yaml")));
});

test("loadDefaults returns the expected stack keys and flags", () => {
  const d = loadDefaults();
  assert.deepEqual(
    Object.keys(d.stack).sort(),
    ["backend", "cloud", "database", "frontend", "packageManager"],
  );
  assert.deepEqual(Object.keys(d.flags).sort(), ["hasFrontend", "runsInCloud", "usesAI"]);
  assert.equal(typeof d.flags.usesAI, "boolean");
});

test("loadPacksIndex returns 29 entries in strictly ascending order", () => {
  const index = loadPacksIndex();
  assert.equal(index.length, 29);
  for (let i = 1; i < index.length; i++) {
    assert.ok(index[i].order > index[i - 1].order, "index not in ascending order");
  }
});

test("loadAllPacks returns every pack, in index order, each valid with a non-empty body", () => {
  const packs = loadAllPacks();
  const index = loadPacksIndex();
  assert.equal(packs.length, index.length);
  // same order as the index
  assert.deepEqual(packs.map((p) => p.name), index.map((e) => e.name));
  for (const p of packs) {
    // LoadedPack carries loader metadata (path/order) that is not part of the
    // neutral RulePack schema; validate only the schema-relevant fields.
    const { path, order, ...rulePack } = p;
    void path;
    void order;
    assert.ok(validateRulePack(rulePack).valid, `pack ${p.name} invalid`);
    assert.ok(p.body.trim().length > 0, `pack ${p.name} has empty body`);
    assert.ok(p.body.startsWith("## "), `pack ${p.name} body should start with its heading`);
  }
});

test("loadAllPacks preserves the templated packs' raw {{placeholders}} (rendering happens later)", () => {
  const stack = loadAllPacks().find((p) => p.name === "stack");
  assert.ok(stack, "stack pack missing");
  assert.ok(/\{\{packageManager\}\}/.test(stack!.body), "stack pack should keep raw placeholders");
});
