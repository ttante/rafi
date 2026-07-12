/**
 * Regression guards for the rule-pack registry itself (complementing parity.test.ts,
 * which proves the *content* survived the shard).
 *
 * parity.test.ts iterates the index, so a stray pack file on disk that is missing
 * from the index — or index drift in category/condition/template ordering — would
 * slip past it. These tests pin the index ⇄ disk relationship and the per-entry
 * metadata against each pack's own front-matter, plus the defaults ⇄ placeholder
 * coverage that makes the templated packs render byte-equivalent to the source.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const RULES_DIR = join(PKG, "content/rules");

interface IndexEntry {
  name: string;
  category: string;
  path: string;
  condition: string;
  template: boolean;
  supersededByForeman?: boolean;
  order: number;
}
const index = (
  parseYaml(readFileSync(join(RULES_DIR, "packs.index.yaml"), "utf8")) as { packs: IndexEntry[] }
).packs;

interface Defaults {
  stack: Record<string, string>;
  flags: Record<string, boolean>;
}
const defaults = parseYaml(
  readFileSync(join(PKG, "content/defaults.yaml"), "utf8"),
) as Defaults;

/** Every `.md` under content/rules, as paths relative to RULES_DIR. */
function packFilesOnDisk(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name.endsWith(".md")) out.push(relative(RULES_DIR, full));
    }
  };
  walk(RULES_DIR);
  return out.sort();
}

/** Parse a pack file into front-matter + body. */
function readPack(relPath: string): { fm: Record<string, unknown>; body: string } {
  const raw = readFileSync(join(RULES_DIR, relPath), "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(m, `pack ${relPath} is missing front-matter`);
  return { fm: parseYaml(m![1]) as Record<string, unknown>, body: m![2] };
}

test("index and on-disk pack files are in exact one-to-one correspondence", () => {
  const onDisk = packFilesOnDisk();
  const indexed = index.map((e) => e.path).sort();
  // Catches both orphan files (on disk, not indexed) and dangling entries
  // (indexed, not on disk) in a single diff.
  assert.deepEqual(indexed, onDisk);
});

test("index names and paths are unique", () => {
  const names = index.map((e) => e.name);
  const paths = index.map((e) => e.path);
  assert.equal(new Set(names).size, names.length, "duplicate pack name in index");
  assert.equal(new Set(paths).size, paths.length, "duplicate pack path in index");
});

test("index order values are strictly ascending and unique", () => {
  for (let i = 1; i < index.length; i++) {
    assert.ok(
      index[i].order > index[i - 1].order,
      `order not ascending at ${index[i].name}: ${index[i - 1].order} -> ${index[i].order}`,
    );
  }
});

test("each index entry's path lives under its declared category directory", () => {
  for (const e of index) {
    assert.ok(
      e.path.startsWith(`${e.category}/`),
      `pack ${e.name}: path ${e.path} is not under category dir ${e.category}/`,
    );
  }
});

test("index metadata matches each pack's front-matter exactly", () => {
  for (const e of index) {
    const { fm } = readPack(e.path);
    assert.equal(fm.name, e.name, `${e.path}: name mismatch`);
    assert.equal(fm.category, e.category, `${e.path}: category mismatch`);
    assert.equal(fm.condition, e.condition, `${e.path}: condition mismatch`);
    assert.equal(fm.template, e.template, `${e.path}: template mismatch`);
    // supersededByForeman is optional; the index omits it when falsy, and the
    // front-matter likewise omits it. Normalize both to a boolean before comparing.
    assert.equal(
      Boolean(fm.supersededByForeman),
      Boolean(e.supersededByForeman),
      `${e.path}: supersededByForeman mismatch`,
    );
  }
});

test("defaults.yaml covers exactly the placeholders used by templated packs", () => {
  const used = new Set<string>();
  for (const e of index) {
    if (!e.template) continue;
    const { body } = readPack(e.path);
    for (const m of body.matchAll(/\{\{(\w+)\}\}/g)) used.add(m[1]);
  }
  const provided = new Set([...Object.keys(defaults.stack), "docsRoot"]);

  const missing = [...used].filter((k) => !provided.has(k));
  assert.deepEqual(missing, [], `defaults.stack missing keys: ${missing.join(", ")}`);

  const unused = Object.keys(defaults.stack).filter((k) => !used.has(k));
  assert.deepEqual(unused, [], `defaults.stack has unused keys: ${unused.join(", ")}`);
});

test("templated packs declare template:true; only those carry placeholders", () => {
  for (const e of index) {
    const { body } = readPack(e.path);
    const hasPlaceholder = /\{\{\w+\}\}/.test(body);
    assert.equal(
      hasPlaceholder,
      e.template,
      `pack ${e.name}: template=${e.template} but hasPlaceholder=${hasPlaceholder}`,
    );
  }
});
