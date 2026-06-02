/**
 * Phase 4 — agent (role) manifests. Validates the four authored manifests and pins
 * that every pack ref (listed + conditional) and skill ref actually resolves — the
 * guard that a role can't reference a pack/skill that doesn't exist.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAgent, loadAllAgents, AGENT_ROLES } from "../src/agents.js";
import { skillNames } from "../src/skills.js";
import { loadPacksIndex } from "../src/content.js";
import { resolvePackRefs } from "../src/resolve.js";
import { validateAgentManifest, type ConditionalPacks } from "rafi-spec";

const index = loadPacksIndex();
const allSkills = new Set(skillNames());

test("the four expected roles all exist, names unique", () => {
  const agents = loadAllAgents();
  assert.deepEqual(agents.map((a) => a.role).sort(), [...AGENT_ROLES].sort());
  const names = agents.map((a) => a.name);
  assert.equal(new Set(names).size, names.length, "duplicate agent name");
});

test("every manifest validates against the AgentManifest schema", () => {
  for (const a of loadAllAgents()) {
    assert.ok(validateAgentManifest(a).valid, `agent ${a.name} invalid: ${JSON.stringify(a)}`);
  }
});

test("every pack ref (listed + conditional) resolves against the index", () => {
  for (const a of loadAllAgents()) {
    // listed packs
    assert.doesNotThrow(
      () => resolvePackRefs(a.packs, index),
      `agent ${a.name}: a listed pack ref does not resolve`,
    );
    // conditional packs
    const cond = (a.conditionalPacks ?? {}) as ConditionalPacks;
    for (const group of Object.values(cond)) {
      if (!group) continue;
      assert.doesNotThrow(
        () => resolvePackRefs(group, index),
        `agent ${a.name}: a conditional pack ref does not resolve`,
      );
    }
  }
});

test("every skill ref points at a real skill", () => {
  for (const a of loadAllAgents()) {
    for (const skill of a.skills) {
      assert.ok(allSkills.has(skill), `agent ${a.name} references unknown skill: ${skill}`);
    }
  }
});

test("loadAgent returns a named manifest and throws on unknown", () => {
  assert.equal(loadAgent("builder").role, "builder");
  assert.throws(() => loadAgent("nope"), /unknown agent/i);
});
