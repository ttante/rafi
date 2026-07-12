/**
 * Phase 2 gate (T024): prove the rule-pack shard lost nothing.
 *
 * For every `## ` section in the frozen rules.md snapshot, assert that exactly one
 * pack reproduces it — verbatim for normal packs, and for `template: true` packs
 * after rendering `{{placeholders}}` with content/defaults.yaml. Every section is
 * covered, including "Test-Driven Development" (its `process/tdd` pack flattens into
 * AGENTS.md byte-for-byte; the richer `tdd` skill handles progressive disclosure).
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
  docsRoot?: string;
}
const defaults = {
  ...(parseYaml(readFileSync(join(PKG, "content/defaults.yaml"), "utf8")) as Defaults),
  docsRoot: "docs",
};

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
    if (key === "docsRoot") return defaults.docsRoot ?? "docs";
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

test("index lists one pack per section (30 sections → 30 packs)", () => {
  const sections = snapshotSections();
  assert.equal(sections.size, 30, "snapshot should have 30 sections");
  assert.equal(index.length, 30, "index should list 30 packs");
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

  // Every section is now covered by a pack (TDD has both a process/tdd pack for
  // byte-for-byte flattening AND the richer tdd skill for progressive disclosure).
  const uncovered = [...sections.keys()].filter((h) => !coveredHeadings.has(h));
  assert.deepEqual(uncovered, []);
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
