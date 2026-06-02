/**
 * Phase 3 — the golden gate. `composeRulesMarkdown()` rebuilds the flattened rules
 * doc (the Codex `AGENTS.md` form) from the bundled preamble + packs, rendering
 * templated packs with the defaults.
 *
 * The frozen snapshot is byte-identical to the original `aiTools/agent-files/AGENTS.md`
 * (verified out of band), so asserting `compose() === snapshot` is the byte-for-byte
 * reproduction gate — and it stays valid after `aiTools/` is deleted in Phase 7,
 * unlike a fixture that reaches outside the package.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { composeRulesMarkdown } from "../src/compile.js";
import { loadDefaults } from "../src/content.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = join(HERE, "fixtures/rules.snapshot.md");
const snapshot = readFileSync(SNAPSHOT, "utf8");

test("composeRulesMarkdown reproduces the golden rules doc byte-for-byte", () => {
  assert.equal(composeRulesMarkdown(), snapshot);
});

test("composing is deterministic (same bytes every time)", () => {
  assert.equal(composeRulesMarkdown(), composeRulesMarkdown());
});

test("explicit defaults produce the same result as the implicit load", () => {
  assert.equal(composeRulesMarkdown({ defaults: loadDefaults() }), snapshot);
});

test("custom stack values are substituted into the templated sections", () => {
  const out = composeRulesMarkdown({
    defaults: {
      stack: {
        frontend: "Svelte",
        backend: "Go",
        database: "SQLite",
        cloud: "GCP",
        packageManager: "bun",
      },
      flags: { hasFrontend: true, usesAI: false, runsInCloud: true },
    },
  });
  // Substituted values appear…
  assert.ok(out.includes("Default package manager: `bun`."), "packageManager not substituted");
  assert.ok(out.includes("Default frontend: Svelte."), "frontend not substituted");
  assert.ok(out.includes("Use SQLite by default."), "database not substituted");
  assert.ok(out.includes("Document GCP account/region assumptions"), "cloud not substituted");
  // …and the original defaults are gone.
  assert.ok(!out.includes("Default frontend: React with TypeScript."), "default frontend leaked");
  // Non-templated content is untouched.
  assert.ok(out.includes("## Security, Privacy, And Compliance"));
});

test("the composed doc contains every section heading, including TDD", () => {
  const headings = [...snapshot.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  const out = composeRulesMarkdown();
  for (const h of headings) assert.ok(out.includes(`## ${h}`), `missing section: ${h}`);
  assert.ok(out.includes("## Test-Driven Development"));
});
