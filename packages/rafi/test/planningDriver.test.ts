import test from "node:test";
import assert from "node:assert/strict";
import { handlePlanningInput, type PlanningInputPrompts } from "../src/planningDriver.js";
import { GRILL_ME_STOP_CHOICE } from "../src/grillAudit.js";

const registry = { version: 1 as const, snapshot_storage: "local" as const, entries: [] };
const CANCEL = Symbol("cancel");

function scripted(values: unknown[]): PlanningInputPrompts & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    select: async (options) => { calls.push(options); return values.shift(); },
    text: async (options) => { calls.push(options); return values.shift(); },
    isCancel: (value) => value === CANCEL,
  };
}

async function input(prompts: PlanningInputPrompts, choices?: string[]) {
  return handlePlanningInput({ projectDir: "/tmp", output: "", question: "Which approach?", choices, registry, interactive: true, prompts });
}

test("planning input returns the exact selected planner choice", async () => {
  const prompts = scripted(["planner-choice-1"]);
  const result = await input(prompts, ["First (Recommended)", "Second"]);
  assert.equal(result.answer, "Second");
  assert.equal(result.cancelled, false);
  assert.deepEqual(prompts.calls[0]?.options, [
    { value: "planner-choice-0", label: "First (Recommended)" },
    { value: "planner-choice-1", label: "Second" },
    { value: "custom-response", label: "Custom response" },
  ]);
});

test("planning input preserves a custom answer and choice-less text", async () => {
  const custom = await input(scripted(["custom-response", "  keep this exactly  "]), ["custom-response", "Other"]);
  assert.equal(custom.answer, "  keep this exactly  ");
  const text = await input(scripted(["plain answer"]));
  assert.equal(text.answer, "plain answer");
});

test("planning input handles selector and custom-text cancellation", async () => {
  assert.equal((await input(scripted([CANCEL]), ["A"])).cancelled, true);
  assert.equal((await input(scripted(["custom-response", CANCEL]), ["A"])).cancelled, true);
});

test("planning input preserves the exhaustive grill-me stop choice", async () => {
  const result = await input(scripted(["planner-choice-1"]), ["Continue (Recommended)", GRILL_ME_STOP_CHOICE]);
  assert.equal(result.answer, GRILL_ME_STOP_CHOICE);
});
