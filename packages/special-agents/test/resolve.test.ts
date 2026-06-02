/**
 * Phase 3 — pack resolution. Turns a role's pack references into an ordered, deduped
 * list of concrete packs: glob expansion via the index, conditional packs gated by
 * flags, and `supersededByForeman` filtering when the foreman tracker is active.
 *
 * Uses the real bundled index so globs resolve to real packs; manifests are minimal
 * synthetic fixtures.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPacksIndex } from "../src/content.js";
import { resolvePackRefs, resolveAgentPacks } from "../src/resolve.js";

const index = loadPacksIndex();
const names = (entries: { name: string }[]) => entries.map((e) => e.name);

// ───────────────────────────── resolvePackRefs ─────────────────────────────

test("expands a category glob to all its packs in index order", () => {
  const out = resolvePackRefs(["base/*"], index);
  assert.deepEqual(names(out), [
    "core",
    "git-safety",
    "code-quality",
    "definition-of-done",
    "response-expectations",
  ]);
});

test("resolves an explicit category/name ref", () => {
  assert.deepEqual(names(resolvePackRefs(["process/testing"], index)), ["testing"]);
});

test("preserves ref order across multiple refs", () => {
  const out = resolvePackRefs(["domain/security", "process/testing", "base/core"], index);
  assert.deepEqual(names(out), ["security", "testing", "core"]);
});

test("dedupes overlapping refs, keeping first occurrence", () => {
  const out = resolvePackRefs(["base/core", "base/*"], index);
  // core appears once, at its first (explicit) position, then the rest of base/*
  assert.deepEqual(names(out), [
    "core",
    "git-safety",
    "code-quality",
    "definition-of-done",
    "response-expectations",
  ]);
});

test("throws on an unknown explicit ref", () => {
  assert.throws(() => resolvePackRefs(["domain/nope"], index), /unknown pack ref.*domain\/nope/i);
});

test("throws on a glob that matches no packs", () => {
  assert.throws(() => resolvePackRefs(["bogus/*"], index), /no packs match.*bogus/i);
});

// ───────────────────────────── resolveAgentPacks ─────────────────────────────

const manifest = {
  packs: ["base/core", "process/testing"],
  conditionalPacks: {
    ai: ["domain/ai-safety", "domain/ai-evals"],
    frontend: ["domain/accessibility"],
  },
};

test("omits conditional packs when their flag is off", () => {
  const out = resolveAgentPacks(manifest, { conditions: {} }, index);
  assert.deepEqual(names(out), ["core", "testing"]);
});

test("includes a conditional group only when its flag is on", () => {
  const out = resolveAgentPacks(manifest, { conditions: { ai: true } }, index);
  assert.deepEqual(names(out), ["core", "testing", "ai-safety", "ai-evals"]);
});

test("includes multiple conditional groups, appended after the base refs", () => {
  const out = resolveAgentPacks(manifest, { conditions: { ai: true, frontend: true } }, index);
  assert.deepEqual(names(out), ["core", "testing", "ai-safety", "ai-evals", "accessibility"]);
});

test("drops supersededByForeman packs when the tracker is active", () => {
  const m = { packs: ["process/tickets", "process/testing"] };
  const withTracker = resolveAgentPacks(m, { conditions: {}, foremanActive: true }, index);
  assert.deepEqual(names(withTracker), ["testing"], "tickets pack should be dropped");
  const without = resolveAgentPacks(m, { conditions: {}, foremanActive: false }, index);
  assert.deepEqual(names(without), ["tickets", "testing"], "tickets pack should be kept");
});

test("dedupes a pack that appears both explicitly and via a conditional group", () => {
  const m = {
    packs: ["domain/accessibility"],
    conditionalPacks: { frontend: ["domain/accessibility"] },
  };
  const out = resolveAgentPacks(m, { conditions: { frontend: true } }, index);
  assert.deepEqual(names(out), ["accessibility"]);
});
