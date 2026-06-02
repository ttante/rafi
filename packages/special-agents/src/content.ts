/**
 * Loads the bundled authoring content (rule packs, their index, and the default
 * stack/flags) that the composition step consumes.
 *
 * `parseRulePack` is a pure string→RulePack transform (front-matter split + schema
 * validation) kept separate from the filesystem helpers so the parse rules are
 * unit-testable. `CONTENT_DIR` resolves the same whether this module runs from
 * `src/` (tsx/tests) or `dist/` (published) because `content/` ships alongside both.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { type RulePack, assertRulePack } from "rafi-spec";

/** Absolute path to the bundled `content/` directory. */
export const CONTENT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "content");
const RULES_DIR = join(CONTENT_DIR, "rules");

const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

/** Parse a rule-pack markdown string into its validated front-matter + body. */
export function parseRulePack(raw: string): RulePack {
  const m = raw.match(FRONT_MATTER);
  if (!m) throw new Error("rule pack is missing front-matter");
  const fm = parseYaml(m[1]) as unknown;
  assertRulePack(fm); // throws "Invalid rule pack: …" on schema failure
  return { ...fm, body: m[2] };
}

/** Default stack strings + flags (content/defaults.yaml). */
export interface Defaults {
  stack: Record<string, string>;
  flags: Record<string, boolean>;
}

/** Read content/defaults.yaml. */
export function loadDefaults(): Defaults {
  return parseYaml(readFileSync(join(CONTENT_DIR, "defaults.yaml"), "utf8")) as Defaults;
}

/** The flattened-rules-doc preamble (everything before the first section). */
export function loadPreamble(): string {
  return readFileSync(join(CONTENT_DIR, "preamble.md"), "utf8");
}

/** One row of content/rules/packs.index.yaml. */
export interface PackIndexEntry {
  name: string;
  category: string;
  path: string;
  condition: string;
  template: boolean;
  supersededByForeman?: boolean;
  order: number;
}

/** Read the pack registry, sorted by its `order` field. */
export function loadPacksIndex(): PackIndexEntry[] {
  const parsed = parseYaml(readFileSync(join(RULES_DIR, "packs.index.yaml"), "utf8")) as {
    packs: PackIndexEntry[];
  };
  return [...parsed.packs].sort((a, b) => a.order - b.order);
}

/** A loaded pack: its parsed content plus where it sits in the registry. */
export interface LoadedPack extends RulePack {
  /** Path relative to content/rules (e.g. `base/core.md`). */
  path: string;
  order: number;
}

/** Load a single pack file by its path relative to content/rules. */
export function loadPack(relPath: string): RulePack {
  return parseRulePack(readFileSync(join(RULES_DIR, relPath), "utf8"));
}

/** Load every pack listed in the index, in index order. */
export function loadAllPacks(): LoadedPack[] {
  return loadPacksIndex().map((entry) => ({
    ...loadPack(entry.path),
    path: entry.path,
    order: entry.order,
  }));
}

/** Absolute path to the bundled `content/docs/` directory. */
export const DOCS_DIR = join(CONTENT_DIR, "docs");

/** One entry from content/docs/docs.index.yaml. */
export interface DocIndexEntry {
  /** Path relative to content/docs/ (and will be placed under targetDir/docs/). */
  path: string;
  /** Copy gate: always | ai | frontend. */
  gate: "always" | "ai" | "frontend";
}

/** Read content/docs/docs.index.yaml. */
export function loadDocsIndex(): DocIndexEntry[] {
  const parsed = parseYaml(readFileSync(join(DOCS_DIR, "docs.index.yaml"), "utf8")) as {
    docs: DocIndexEntry[];
  };
  return parsed.docs;
}

/** Names of the pack files physically present under content/rules (for drift checks). */
export function packFilesOnDisk(): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) walk(join(dir, ent.name), `${prefix}${ent.name}/`);
      else if (ent.name.endsWith(".md")) out.push(`${prefix}${ent.name}`);
    }
  };
  walk(RULES_DIR, "");
  return out.sort();
}
