// M5 plan item 29 (C220, C221, C222): the fixed tag list comes from special-agents' `content/tags.yaml`; packs and
// skills reach a session only on a matching tag (`always` for the core), skills by name and description only;
// templated packs are rendered; the tools a ticket gets are those whose tags and roles match.
import { test } from "node:test";
import assert from "node:assert/strict";
import { realFs } from "../../src/deps/real/fs.js";
import { fixedTags, loadContent, packsFor, packTexts, skillsFor } from "../../src/instructions/packs.js";
import { tagPatterns } from "../../src/instructions/tags.js";
import { toolsFor } from "../../src/tools/registry.js";

const fs = realFs({ id: () => "x", jitter: () => 0 });

test("the fixed list is special-agents' tags.yaml, with ui's default patterns; the project's patterns add", async () => {
  const fixed = await fixedTags(fs);
  assert.deepEqual(Object.keys(fixed), ["ui", "backend", "api", "database", "ai", "mobile", "push", "auth",
    "security", "infra", "docs", "testing"]);
  assert.deepEqual(fixed.ui, ["**/*.tsx", "**/*.jsx", "**/*.css", "**/*.vue"]);
  const patterns = tagPatterns({ tags: { value: { ui: { patterns: ["**/*.svelte"] }, pay: { patterns: ["p/**"] } },
    source: "project" } }, fixed);
  assert.ok(patterns.ui!.includes("**/*.svelte") && patterns.ui!.includes("**/*.tsx"));
  assert.deepEqual(patterns.pay, ["p/**"]);
});

test("packs by tag: a database ticket gets no AI pack, an ai ticket does; both get the always core", async () => {
  const content = await loadContent(fs);
  const db = packsFor(content, new Set(["database"])).map((p) => p.name);
  const ai = packsFor(content, new Set(["ai"])).map((p) => p.name);
  assert.ok(db.includes("core") && ai.includes("core"), "the core is always there");
  assert.ok(db.includes("database"));
  assert.ok(!db.some((n) => n.startsWith("ai-")), JSON.stringify(db));
  assert.ok(ai.includes("ai-safety") && ai.includes("ai-evals"));
  assert.ok(!ai.includes("accessibility"), "ui's pack needs ui");
  assert.equal(new Set(ai).size, ai.length, "each pack once");
});

test("templated packs render from the defaults and the project's stack; no placeholder is left", async () => {
  const content = await loadContent(fs);
  const texts = await packTexts(fs, content, packsFor(content, new Set(["database"])), { stack:
    { database: "SQLite" }, docsRoot: "documents" });
  const joined = texts.join("\n");
  assert.match(joined, /Use SQLite by default/);
  assert.doesNotMatch(joined, /\{\{/);
  assert.doesNotMatch(joined, /^---$/m, "front matter is stripped");
});

test("skills: the role's own, by tag, with name and description only", async () => {
  const content = await loadContent(fs);
  const builder = skillsFor(content, "builder", new Set(["database"]));
  assert.ok(builder.some((s) => s.name === "tdd"));
  assert.ok(!builder.some((s) => s.name === "grill-me"), "not the builder's");
  for (const s of builder) assert.deepEqual(Object.keys(s).sort(), ["description", "name", "path"]);
  assert.ok(!skillsFor(content, "builder", new Set(["database"])).some((s) => s.name === "prd-to-issues"));
});

test("tools: a ticket gets a tool when one of its tags and its role match", () => {
  const tools = { playwright: { kind: "mcp", start: { command: "npx", args: ["@playwright/mcp@1", "--isolated"] },
    description: "Drive a browser to check web UI", roles: ["qa", "builder"], tags: ["ui"],
    setup_notes: "docs/tools/playwright.md" }, push: { kind: "command", start: { command: "scripts/push.sh" },
    description: "Send a test push", roles: ["qa"], tags: ["push"] } };
  assert.deepEqual(toolsFor(tools, "builder", new Set(["ui"])).map((t) => t.name), ["playwright"]);
  assert.deepEqual(toolsFor(tools, "builder", new Set(["push"])), [], "push is QA's only");
  assert.deepEqual(toolsFor(tools, "qa", new Set(["database"])), []);
  const [pw] = toolsFor(tools, "qa", new Set(["ui", "push"]));
  assert.equal(pw!.line, "playwright, for drive a browser to check web UI. Setup notes: docs/tools/playwright.md");
  assert.deepEqual(pw!.mcp, { command: "npx", args: ["@playwright/mcp@1", "--isolated"] });
  assert.equal(toolsFor(tools, "qa", new Set(["push"]))[0]!.mcp, null, "a command tool isn't an MCP server");
});
