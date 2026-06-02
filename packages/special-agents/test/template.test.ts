/**
 * Phase 3 — templating engine (§3 "Templating mechanism").
 *
 * The engine is intentionally tiny: only `{{var}}` substitution and
 * `{{#if flag}}…{{/if}}` keep/strip. No nesting, no expressions. These tests pin
 * that minimal contract, including the failure modes (unknown var/flag throw, so a
 * typo can never render a silent blank into agent guidance).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "../src/template.js";

const ctx = {
  vars: { frontend: "Vue", database: "MySQL", packageManager: "npm" },
  flags: { hasFrontend: true, usesAI: false },
};

test("substitutes {{var}} from vars", () => {
  assert.equal(render("Default frontend: {{frontend}}.", ctx), "Default frontend: Vue.");
});

test("substitutes multiple and repeated vars", () => {
  assert.equal(
    render("{{packageManager}} + {{database}} + {{packageManager}}", ctx),
    "npm + MySQL + npm",
  );
});

test("passes through text with no placeholders unchanged", () => {
  const s = "- A plain rule line with no directives.\n- Another.";
  assert.equal(render(s, ctx), s);
});

test("keeps {{#if flag}} body (and drops the markers) when the flag is true", () => {
  assert.equal(render("a{{#if hasFrontend}}B{{/if}}c", ctx), "aBc");
});

test("drops the whole block when the flag is false", () => {
  assert.equal(render("a{{#if usesAI}}B{{/if}}c", ctx), "ac");
});

test("handles multiple independent if-blocks in one document", () => {
  const tpl = "{{#if hasFrontend}}UI{{/if}}|{{#if usesAI}}AI{{/if}}|tail";
  assert.equal(render(tpl, ctx), "UI||tail");
});

test("renders vars inside a kept if-block", () => {
  assert.equal(render("{{#if hasFrontend}}fe={{frontend}}{{/if}}", ctx), "fe=Vue");
});

test("does NOT render vars inside a dropped if-block (and never throws for them)", () => {
  // {{missing}} only appears in a stripped block, so it must not trigger the
  // unknown-var guard.
  assert.equal(render("x{{#if usesAI}}{{missing}}{{/if}}y", ctx), "xy");
});

test("throws on an unknown {{var}}", () => {
  assert.throws(() => render("hi {{nope}}", ctx), /unknown placeholder.*nope/i);
});

test("throws on an unknown flag in {{#if}}", () => {
  assert.throws(() => render("a{{#if mystery}}b{{/if}}", ctx), /unknown flag.*mystery/i);
});

test("renders the real stack pack body byte-equivalently to its defaults form", () => {
  // The shape used by the templated packs: only {{var}} substitution.
  const body = "- Default package manager: `{{packageManager}}`.\n- Default frontend: {{frontend}}.";
  const out = render(body, {
    vars: { packageManager: "pnpm", frontend: "React with TypeScript" },
    flags: {},
  });
  assert.equal(out, "- Default package manager: `pnpm`.\n- Default frontend: React with TypeScript.");
});
