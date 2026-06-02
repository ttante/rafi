/**
 * Skill loader. Reads `content/skills/<name>/SKILL.md` units — the standard
 * Anthropic format plus the optional Rafi `pins` / `codexPriority` fields. A pure
 * `parseSkillManifest` (string → SkillManifest) is split from the directory walk so
 * the parse rules are unit-tested without disk.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { type SkillManifest, assertSkillManifest } from "rafi-spec";
import { CONTENT_DIR } from "./content.js";

/** Absolute path to the bundled `content/skills/` directory. */
export const SKILLS_DIR = join(CONTENT_DIR, "skills");

const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

/** Parse a SKILL.md string into its validated front-matter + body. */
export function parseSkillManifest(raw: string): SkillManifest {
  const m = raw.match(FRONT_MATTER);
  if (!m) throw new Error("skill is missing front-matter");
  const fm = parseYaml(m[1]) as unknown;
  assertSkillManifest(fm); // throws "Invalid skill manifest: …"
  return { ...fm, body: m[2] };
}

/** Directory names of every bundled skill, sorted. */
export function skillNames(): string[] {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(SKILLS_DIR, e.name, "SKILL.md")))
    .map((e) => e.name)
    .sort();
}

/** Load a single skill by its directory name. */
export function loadSkill(name: string): SkillManifest {
  const path = join(SKILLS_DIR, name, "SKILL.md");
  if (!existsSync(path)) throw new Error(`unknown skill: ${name}`);
  const skill = parseSkillManifest(readFileSync(path, "utf8"));
  if (skill.name !== name) {
    throw new Error(`skill ${name}: manifest name "${skill.name}" does not match its directory`);
  }
  return skill;
}

/** Load every bundled skill, in directory-name order. */
export function loadAllSkills(): SkillManifest[] {
  return skillNames().map(loadSkill);
}
