import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentRuntime } from "../src/compiler.js";
import {
  ensureAgentRuntimesReady,
  RuntimeReadinessError,
} from "../src/runtimeReadiness.js";

test("runtime readiness checks only configured runtimes", async () => {
  const checked: AgentRuntime[] = [];

  await ensureAgentRuntimesReady(
    "/tmp/project",
    ["codex"],
    async () => "cancel",
    (_targetDir, runtime) => {
      checked.push(runtime);
    },
  );

  assert.deepEqual(checked, ["codex"]);
});

test("runtime readiness retries after auth failure and then completes", async () => {
  const checked: AgentRuntime[] = [];
  let prompts = 0;

  await ensureAgentRuntimesReady(
    "/tmp/project",
    ["claude"],
    async (err) => {
      prompts += 1;
      assert.equal(err.runtime, "claude");
      assert.equal(err.authLikely, true);
      assert.match(err.message, /claude -p/);
      assert.match(err.message, /claude auth login --claudeai/);
      return "retry";
    },
    (_targetDir, runtime) => {
      checked.push(runtime);
      if (checked.length === 1) {
        throw new RuntimeReadinessError({
          runtime,
          exitCode: 1,
          stderr: "401 Invalid authentication credentials",
        });
      }
    },
  );

  assert.equal(prompts, 1);
  assert.deepEqual(checked, ["claude", "claude"]);
});

test("runtime readiness cancellation throws without checking later runtimes", async () => {
  const checked: AgentRuntime[] = [];

  await assert.rejects(
    ensureAgentRuntimesReady(
      "/tmp/project",
      ["claude", "codex"],
      async () => "cancel",
      (_targetDir, runtime) => {
        checked.push(runtime);
        throw new RuntimeReadinessError({ runtime, stderr: "not logged in" });
      },
    ),
    RuntimeReadinessError,
  );

  assert.deepEqual(checked, ["claude"]);
});

test("runtime readiness can switch to the other runtime after verification", async () => {
  const checked: AgentRuntime[] = [];

  const finalTargets = await ensureAgentRuntimesReady(
    "/tmp/project",
    ["claude", "codex"],
    async (_err, otherRuntime) => {
      assert.equal(otherRuntime, "codex");
      return "switch";
    },
    (_targetDir, runtime) => {
      checked.push(runtime);
      if (runtime === "claude") {
        throw new RuntimeReadinessError({ runtime, stderr: "not logged in" });
      }
    },
  );

  assert.deepEqual(checked, ["claude", "codex"]);
  assert.deepEqual(finalTargets, ["codex"]);
});

test("runtime readiness throws when fallback runtime is not ready", async () => {
  const checked: AgentRuntime[] = [];

  await assert.rejects(
    ensureAgentRuntimesReady(
      "/tmp/project",
      ["claude"],
      async () => "switch",
      (_targetDir, runtime) => {
        checked.push(runtime);
        throw new RuntimeReadinessError({ runtime, stderr: "not logged in" });
      },
    ),
    /codex exec failed/,
  );

  assert.deepEqual(checked, ["claude", "codex"]);
});
