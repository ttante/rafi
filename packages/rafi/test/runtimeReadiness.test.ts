import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentRuntime } from "../src/compiler.js";
import { RuntimeCleanupError } from "ai-foreman/runtime-readiness.js";
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
      assert.match(err.message, /approved by your organization/);
      assert.doesNotMatch(err.message, /--claudeai|setup-token|auth logout/);
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
  let prompts = 0;

  await assert.rejects(
    ensureAgentRuntimesReady(
      "/tmp/project",
      ["claude"],
      async () => ++prompts === 1 ? "switch" : "cancel",
      (_targetDir, runtime) => {
        checked.push(runtime);
        throw new RuntimeReadinessError({ runtime, stderr: "not logged in" });
      },
    ),
    /codex exec failed/,
  );

  assert.deepEqual(checked, ["claude", "codex"]);
  assert.equal(prompts, 2, "fallback failure must offer recovery instead of exiting directly");
});

test("cleanup uncertainty pauses with truthful diagnostics and retries the same runtime", async () => {
  let checks = 0;
  let prompts = 0;
  const result = await ensureAgentRuntimesReady("/tmp/project", ["claude"], async err => {
    prompts++;
    assert.equal(err.cleanupUnverified, true);
    assert.equal(err.authLikely, false);
    assert.match(err.message, /inventory denied/);
    assert.match(err.message, /Create is paused/);
    assert.match(err.message, /Linux\/WSL/);
    assert.doesNotMatch(err.message, /codex login/);
    return "retry";
  }, () => { if (++checks === 1) throw new RuntimeCleanupError("Standalone probe cleanup is unverified: inventory denied"); });
  assert.deepEqual(result, ["claude"]);
  assert.equal(checks, 2);
  assert.equal(prompts, 1);
});

test("failed fallback can be repaired and retried without leaving create", async () => {
  const checked: AgentRuntime[] = [];
  let prompts = 0;
  const result = await ensureAgentRuntimesReady("/tmp/project", ["claude"], async () => ++prompts === 1 ? "switch" : "retry", (_dir, runtime) => {
    checked.push(runtime);
    if (checked.length < 3) throw new RuntimeReadinessError({ runtime, stderr: "network unavailable" });
  });
  assert.deepEqual(result, ["codex"]);
  assert.deepEqual(checked, ["claude", "codex", "codex"]);
});
