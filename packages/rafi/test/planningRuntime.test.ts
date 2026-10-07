import test from "node:test";
import assert from "node:assert/strict";
import { resolvePlanningRuntime } from "../src/planningRuntime.js";

const CANCEL = Symbol("cancel");

function prompts(answer: unknown) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    prompts: {
      select: async (options: Record<string, unknown>) => { calls.push(options); return answer; },
      isCancel: (value: unknown) => value === CANCEL,
    },
  };
}

test("planning runtime selector recommends Claude when both targets are configured", async () => {
  const scripted = prompts("codex");
  const selected = await resolvePlanningRuntime(["claude", "codex"], true, scripted.prompts);
  assert.deepEqual(selected, { kind: "selected", runtime: "codex" });
  assert.deepEqual(scripted.calls[0], {
    message: "Both runtimes are configured. Which should plan this session?",
    options: [
      { value: "claude", label: "Claude (Recommended)" },
      { value: "codex", label: "Codex" },
    ],
  });
});

test("planning runtime selector accepts Claude and avoids prompts for one or non-interactive targets", async () => {
  const claude = prompts("claude");
  assert.deepEqual(await resolvePlanningRuntime(["claude", "codex"], true, claude.prompts), { kind: "selected", runtime: "claude" });
  const single = prompts("codex");
  assert.deepEqual(await resolvePlanningRuntime(["codex"], true, single.prompts), { kind: "selected", runtime: "codex" });
  assert.equal(single.calls.length, 0);
  assert.deepEqual(await resolvePlanningRuntime(["claude", "codex"], false), { kind: "not-required" });
});

test("planning runtime selector reports cancellation", async () => {
  const scripted = prompts(CANCEL);
  assert.deepEqual(await resolvePlanningRuntime(["claude", "codex"], true, scripted.prompts), { kind: "cancelled" });
});
