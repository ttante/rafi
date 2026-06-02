/**
 * Phase 4 — per-role composition. `composeAgentSystem` renders a role's resolved
 * packs into its system text; `getAgent` bundles that with the role's skills/model/
 * effort. The coverage assertions guard against a role silently losing guidance:
 * each role's composed text must contain the section headings of the packs it pins,
 * and conditional sections must appear only when their flag is on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { composeAgentSystem, getAgent } from "../src/compile.js";
import { loadAgent } from "../src/agents.js";

test("builder system text includes its base + pinned process/domain sections", () => {
  const sys = composeAgentSystem(loadAgent("builder"));
  for (const heading of [
    "## Core Working Agreement", // base/*
    "## Test-Driven Development", // process/tdd
    "## Testing And Verification", // process/testing
    "## Security, Privacy, And Compliance", // domain/security
    "## Robustness And Reliability", // domain/robustness
    "## Default Stack", // templated/*
  ]) {
    assert.ok(sys.includes(heading), `builder system missing: ${heading}`);
  }
});

test("builder templated sections are rendered with the defaults (no raw placeholders)", () => {
  const sys = composeAgentSystem(loadAgent("builder"));
  assert.ok(!/\{\{\w+\}\}/.test(sys), "composed system still contains raw placeholders");
  assert.ok(sys.includes("Default package manager: `pnpm`."));
});

test("AI sections appear only when the ai flag is on", () => {
  const builder = loadAgent("builder");
  const off = composeAgentSystem(builder, { conditions: {} });
  const on = composeAgentSystem(builder, { conditions: { ai: true } });
  assert.ok(!off.includes("## AI And LLM Safety"), "ai section leaked when flag off");
  assert.ok(on.includes("## AI And LLM Safety"), "ai section missing when flag on");
  assert.ok(on.includes("## AI Cost Tracking And Learning Loop"));
});

test("frontend accessibility section is gated by the frontend flag", () => {
  const qa = loadAgent("qa");
  assert.ok(!composeAgentSystem(qa, { conditions: {} }).includes("## Accessibility"));
  assert.ok(composeAgentSystem(qa, { conditions: { frontend: true } }).includes("## Accessibility"));
});

test("foremanActive drops the supersededByForeman tickets section from planner", () => {
  const planner = loadAgent("planner"); // pins process/tickets
  const withTracker = composeAgentSystem(planner, { foremanActive: true });
  const without = composeAgentSystem(planner, { foremanActive: false });
  assert.ok(!withTracker.includes("## Ticket Tracking"), "tickets section should be dropped");
  assert.ok(without.includes("## Ticket Tracking"), "tickets section should be present");
});

test("composition is deterministic", () => {
  const b = loadAgent("builder");
  assert.equal(composeAgentSystem(b), composeAgentSystem(b));
});

test("getAgent bundles system text, skills, model, and effort", () => {
  const qa = getAgent("qa");
  assert.equal(qa.manifest.role, "qa");
  assert.deepEqual(qa.skills, ["grill-me", "tdd"]);
  assert.equal(qa.model, null);
  assert.equal(qa.effort, null);
  assert.ok(qa.system.includes("## Security, Privacy, And Compliance"));
});

test("getAgent passes compose options through (ai flag reaches the builder bundle)", () => {
  assert.ok(getAgent("builder", { conditions: { ai: true } }).system.includes("## AI And LLM Safety"));
});

test("getAgent throws on an unknown role", () => {
  assert.throws(() => getAgent("reviewer"), /unknown agent/i);
});
