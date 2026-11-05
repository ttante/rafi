/**
 * M5 item 36 (ARCH 10.1, C220, C221): `content/tags.yaml` is rafi's fixed tag list (ARCH 10.1's starting tags, with
 * `ui`'s default patterns); every rule pack in `packs.index.yaml` and every skill in `skills/skills.index.yaml`
 * carries `tags:` naming only fixed tags or `always`; `tags:` sits beside `condition:`, which the old engine still
 * reads, so its selection is unchanged (parity.test.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { CONTENT_DIR, loadPacksIndex } from "../src/content.js";
import { skillNames } from "../src/skills.js";

const STARTING = ["ui", "backend", "api", "database", "ai", "mobile", "push", "auth", "security", "infra", "docs",
  "testing"];

type Tag = { name: string; description: string; patterns: string[] };
const tags = (parseYaml(readFileSync(join(CONTENT_DIR, "tags.yaml"), "utf8")) as { tags: Tag[] }).tags;
const known = new Set([...tags.map((t) => t.name), "always"]);

test("tags.yaml lists ARCH 10.1's starting tags, each with a description, and ui's default patterns", () => {
  assert.deepEqual(tags.map((t) => t.name), STARTING);
  for (const t of tags) assert.ok(t.description.length > 0, t.name);
  assert.deepEqual(tags.find((t) => t.name === "ui")!.patterns, ["**/*.tsx", "**/*.jsx", "**/*.css", "**/*.vue"]);
});

test("every pack has tags beside its condition; only the small core is always", () => {
  const index = loadPacksIndex() as (ReturnType<typeof loadPacksIndex>[number] & { tags?: string[] })[];
  for (const p of index) {
    assert.ok(p.condition, p.name);
    assert.ok(Array.isArray(p.tags) && p.tags.length > 0, `${p.name} has tags`);
    for (const t of p.tags!) assert.ok(known.has(t), `${p.name}: ${t}`);
  }
  const ai = index.filter((p) => p.condition === "ai");
  assert.ok(ai.length > 0 && ai.every((p) => p.tags!.includes("ai") && !p.tags!.includes("always")));
  assert.ok(index.filter((p) => p.tags!.includes("always")).length < index.length / 2, "a small core");
});

test("every skill has tags in the skills index", () => {
  const index = (parseYaml(readFileSync(join(CONTENT_DIR, "skills", "skills.index.yaml"), "utf8")) as
    { skills: { name: string; tags: string[] }[] }).skills;
  assert.deepEqual(index.map((s) => s.name).sort(), skillNames());
  for (const s of index) {
    assert.ok(s.tags.length > 0, s.name);
    for (const t of s.tags) assert.ok(known.has(t), `${s.name}: ${t}`);
  }
});
