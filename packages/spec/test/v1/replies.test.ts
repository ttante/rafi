// Item 19 (M2 plan 3.3): the builder, requirements and verdict reply schemas (ARCH 6.1–6.4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkReply, replySchemas } from "../../src/v1/replies.js";

const BUILDER = [
  { kind: "done", summary: "Added the empty-state message to the panel and a test for it.", runs: [4], block: null,
    question: null },
  { kind: "blocked", summary: null, runs: [], block: { type: "permission", need: "internet",
    reason: "Internet needed to install PostgreSQL" }, question: null },
  { kind: "needs-input", summary: null, runs: [], block: null,
    question: { text: "Which currency should prices use?", choices: ["USD", "EUR"] } },
];
const REQUIREMENTS = {
  requirements: [
    { from: 1, text: "Clicking \"Send test push\" shows \"Sent\".", check: "npm test -- push.test.ts", expect: "passes" },
    { from: 2, text: "The push arrives on a real phone and opens the app.", check: null, expect: null },
  ],
  in_scope: ["The Send test push button", "Delivering a test push"], out_of_scope: ["Scheduling pushes"],
  risks: ["The push provider's sandbox can be slow"], add_tags: ["ui"],
};
const VERDICT = {
  results: [
    { req: 1, status: "satisfied", runs: [6], needs: null, note: null },
    { req: 2, status: "not-satisfied", runs: [7], needs: null, note: "With an empty list the panel renders nothing." },
    { req: 3, status: "unable", runs: [], needs: "browser", note: "The panel only renders in a browser." },
  ],
  summary: "R2 fails; R3 needs a browser.",
};

test("every example in ARCH 6.2–6.4 validates", () => {
  for (const reply of BUILDER) assert.deepEqual(checkReply("builder", reply), { ok: true, value: reply });
  assert.equal(checkReply("requirements", REQUIREMENTS).ok, true);
  assert.equal(checkReply("verdict", VERDICT).ok, true);
});

test("an extra field (a ticket id, a session id) fails the schema: the binding mismatch of S-MAL-4", () => {
  const r = checkReply("builder", { ...BUILDER[0], ticket: "T9" });
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.errors.join("; "), /ticket/);
  assert.equal(checkReply("verdict", { ...VERDICT, session_id: "abc" }).ok, false);
});

test("missing fields and wrong types are named", () => {
  const { summary: _s, ...missing } = BUILDER[0]!;
  const r = checkReply("builder", missing);
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.errors.join("; "), /summary/);
  const wrong = checkReply("builder", { ...BUILDER[0], runs: "4" });
  assert.match(wrong.ok ? "" : wrong.errors.join("; "), /runs/);
  assert.equal(checkReply("verdict", { ...VERDICT, results: [{ ...VERDICT.results[0], status: "ok" }] }).ok, false);
});

test("kind rules: done needs a summary and no block; blocked needs a block; needs-input a question", () => {
  const bad = [
    { ...BUILDER[0], summary: null }, { ...BUILDER[0], block: BUILDER[1]!.block },
    { ...BUILDER[1], block: null }, { ...BUILDER[2], question: null },
  ];
  for (const reply of bad) assert.equal(checkReply("builder", reply).ok, false, JSON.stringify(reply));
});

test("draft-07 JSON Schema: flat, strict, no unions below the top level other than null", () => {
  for (const name of ["builder", "requirements", "verdict"] as const) {
    const json = replySchemas[name].json as Record<string, unknown>;
    assert.equal(json.type, "object");
    assert.equal(json.additionalProperties, false, name);
    const text = JSON.stringify(json);
    assert.doesNotMatch(text, /oneOf/);
    const walk = (node: unknown, depth: number): void => {
      if (!node || typeof node !== "object") return;
      const anyOf = (node as { anyOf?: { type?: string }[] }).anyOf;
      if (anyOf) assert.ok(anyOf.length === 2 && anyOf.some((b) => b.type === "null"), `${name}: only T | null unions`);
      for (const child of Object.values(node)) walk(child, depth + 1);
    };
    walk(json, 0);
    assert.doesNotMatch(text, /handoff_id|finding_key|continuity/);
  }
});

test("the Codex projection makes every property required, nullable ones null-able, and drops uniqueItems", () => {
  for (const name of ["builder", "requirements", "verdict"] as const) {
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const n = node as Record<string, unknown>;
      assert.equal("uniqueItems" in n, false);
      if (n.type === "object" && n.properties) {
        assert.deepEqual([...(n.required as string[])].sort(), Object.keys(n.properties).sort(), name);
      }
      for (const child of Object.values(n)) walk(child);
    };
    walk(replySchemas[name].codex);
  }
  const block = (replySchemas.builder.codex as { properties: Record<string, { anyOf?: unknown[] }> }).properties.block;
  assert.ok(block?.anyOf?.some((b) => (b as { type?: string }).type === "null"));
});

test("run and requirement numbers are positive integers", () => {
  assert.equal(checkReply("builder", { ...BUILDER[0], runs: [0] }).ok, false);
  assert.equal(checkReply("builder", { ...BUILDER[0], runs: [1.5] }).ok, false);
  assert.equal(checkReply("verdict", { ...VERDICT, results: [{ ...VERDICT.results[0], req: 0 }] }).ok, false);
});
