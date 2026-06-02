/**
 * Phase 2 gate (T024): prove the rule-pack shard lost nothing.
 *
 * For every `## ` section in the frozen rules.md snapshot, assert that exactly one
 * pack reproduces it — verbatim for normal packs, and for `template: true` packs
 * after rendering `{{placeholders}}` with content/defaults.yaml. The only section
 * without a pack must be "Test-Driven Development" (it maps to the `tdd` skill).
 *
 * Also validates every pack's front-matter against the RulePack schema and checks
 * that packs.index.yaml matches what is on disk.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { validateRulePack } from "rafi-spec";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const SNAPSHOT = join(PKG, "test/fixtures/rules.snapshot.md");
const RULES_DIR = join(PKG, "content/rules");

interface Defaults {
  stack: Record<string, string>;
  flags: Record<string, boolean>;
}
const defaults = parseYaml(readFileSync(join(PKG, "content/defaults.yaml"), "utf8")) as Defaults;

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

/** Split a pack file into its parsed front-matter and the body that follows. */
function readPack(relPath: string): { fm: Record<string, unknown>; body: string } {
  const raw = readFileSync(join(RULES_DIR, relPath), "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(m, `pack ${relPath} is missing front-matter`);
  return { fm: parseYaml(m![1]) as Record<string, unknown>, body: m![2] };
}

/** Minimal default-render: substitute {{var}} from defaults.stack. (Phase 3 formalizes this.) */
function renderWithDefaults(body: string): string {
  return body.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    assert.ok(key in defaults.stack, `unknown placeholder {{${key}}}`);
    return defaults.stack[key];
  });
}

/** The snapshot's sections, keyed by heading → contiguous chunk ("## Heading\n…"). */
function snapshotSections(): Map<string, string> {
  const text = readFileSync(SNAPSHOT, "utf8");
  const matches = [...text.matchAll(/^## (.+)$/gm)];
  const out = new Map<string, string>();
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index!;
    const end = i + 1 < matches.length ? matches[i + 1].index! : text.length;
    out.set(matches[i][1], text.slice(start, end));
  }
  return out;
}

test("index lists 28 packs covering every section except TDD", () => {
  const sections = snapshotSections();
  assert.equal(sections.size, 29, "snapshot should have 29 sections");
  assert.equal(index.length, 28, "index should list 28 packs");
});

test("each pack renders back to its exact source section", () => {
  const sections = snapshotSections();
  // Map pack -> heading by matching the first line of the (rendered) body.
  const coveredHeadings = new Set<string>();

  for (const entry of index) {
    const { fm, body } = readPack(entry.path);

    // front-matter validates against the schema
    const res = validateRulePack(fm);
    assert.ok(res.valid, `pack ${entry.name} invalid: ${res.errors.join("; ")}`);
    assert.equal(fm.name, entry.name);
    assert.equal(fm.template, entry.template);

    const rendered = entry.template ? renderWithDefaults(body) : body;
    const heading = rendered.match(/^## (.+)$/m)?.[1];
    assert.ok(heading, `pack ${entry.name} body has no heading`);
    const source = sections.get(heading!);
    assert.ok(source, `pack ${entry.name} heading not found in snapshot: ${heading}`);
    assert.equal(rendered, source, `pack ${entry.name} does not match source section byte-for-byte`);
    coveredHeadings.add(heading!);
  }

  // The only uncovered section is TDD (→ skill).
  const uncovered = [...sections.keys()].filter((h) => !coveredHeadings.has(h));
  assert.deepEqual(uncovered, ["Test-Driven Development"]);
});

test("templated packs actually contain placeholders; non-templated do not", () => {
  for (const entry of index) {
    const { body } = readPack(entry.path);
    const hasPlaceholder = /\{\{\w+\}\}/.test(body);
    assert.equal(
      hasPlaceholder,
      entry.template,
      `pack ${entry.name}: template=${entry.template} but hasPlaceholder=${hasPlaceholder}`,
    );
  }
});
