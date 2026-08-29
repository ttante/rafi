/**
 * Phase 4 — skill loader. Reads the moved `content/skills/<name>/SKILL.md` units
 * (the Anthropic format + optional Rafi `pins`/`codexPriority`). Splits a pure
 * `parseSkillManifest` from the directory walk, and checks the real bundled skills.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  SKILLS_DIR,
  parseSkillManifest,
  loadSkill,
  loadAllSkills,
  skillNames,
} from "../src/skills.js";
import { validateSkillManifest } from "rafi-spec";

const EXPECTED = [
  "better-sqlite3-rebuild",
  "grill-me",
  "handoff",
  "improve-codebase-architecture",
  "prd-to-issues",
  "tdd",
  "write-a-prd",
];

const SAMPLE = `---
name: demo-skill
description: A demo skill.
pins: [testing, code-quality]
codexPriority: inline
---
# Demo

Body text.
`;

test("parseSkillManifest returns validated front-matter + body", () => {
  const s = parseSkillManifest(SAMPLE);
  assert.equal(s.name, "demo-skill");
  assert.deepEqual(s.pins, ["testing", "code-quality"]);
  assert.equal(s.codexPriority, "inline");
  assert.ok(s.body?.includes("Body text."));
  assert.ok(validateSkillManifest(s).valid);
});

test("parseSkillManifest throws on missing front-matter", () => {
  assert.throws(() => parseSkillManifest("# No front-matter"), /front-matter/i);
});

test("parseSkillManifest throws on an invalid manifest", () => {
  const bad = `---\nname: Bad_Name\ndescription: ""\n---\nbody`;
  assert.throws(() => parseSkillManifest(bad), /Invalid skill manifest/i);
});

test("SKILLS_DIR exists and holds the moved skills", () => {
  assert.ok(existsSync(SKILLS_DIR));
  assert.ok(existsSync(join(SKILLS_DIR, "tdd", "SKILL.md")));
});

test("skillNames lists exactly the expected skills", () => {
  assert.deepEqual(skillNames().sort(), [...EXPECTED].sort());
});

test("loadAllSkills: each manifest validates and its name equals its directory", () => {
  const skills = loadAllSkills();
  assert.equal(skills.length, EXPECTED.length);
  for (const s of skills) {
    const { body, ...meta } = s;
    void body;
    assert.ok(validateSkillManifest(meta).valid, `skill ${s.name} invalid`);
    assert.ok(s.description.trim().length > 0, `skill ${s.name} has empty description`);
  }
});

test("loadSkill returns the named skill's body", () => {
  const tdd = loadSkill("tdd");
  assert.equal(tdd.name, "tdd");
  assert.ok(tdd.body?.includes("Test-Driven Development"));
});

test("loadSkill throws on an unknown skill", () => {
  assert.throws(() => loadSkill("does-not-exist"), /unknown skill/i);
});
