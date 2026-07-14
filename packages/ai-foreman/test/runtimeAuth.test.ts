import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";
import {
  formatRuntimeAuthFailure,
  isRuntimeAuthFailure,
  normalizeRuntimeErrorText,
  RuntimeAuthError,
  type AgentRuntime,
} from "../src/runtimeAuth.js";
import { ensureRuntimeReadyForCommand } from "../src/cli/runtimeAuthPrompt.js";
import { resolveAgentForProject } from "../src/cli/runtimeSelection.js";

test("runtime auth detection matches 401 credential output", () => {
  assert.equal(isRuntimeAuthFailure("Error: 401 Invalid authentication credentials"), true);
});

test("runtime auth formatter includes Claude repair commands", () => {
  const message = formatRuntimeAuthFailure({
    runtime: "claude",
    context: "builder turn",
    exitCode: 1,
    stderr: "not logged in",
  });

  assert.match(message, /claude -p failed during builder turn/);
  assert.match(message, /claude auth logout/);
  assert.match(message, /claude auth login --claudeai/);
  assert.match(message, /claude setup-token/);
});

test("runtime auth normalization leaves unrelated errors unchanged", () => {
  assert.equal(
    normalizeRuntimeErrorText("codex", "model overloaded", 1),
    "model overloaded",
  );
});

test("runtime auth normalization expands Codex 401 errors", () => {
  const message = normalizeRuntimeErrorText(
    "codex",
    "401 Invalid authentication credentials",
    1,
    "readiness check",
  );

  assert.match(message, /codex exec failed during readiness check/);
  assert.match(message, /codex login/);
  assert.match(message, /Runtime output:/);
});

test("config-derived default agent uses a single rafi-config target", () => {
  const dir = mkdtempSync(join(tmpdir(), "foreman-runtime-auth-test-"));
  writeFileSync(join(dir, "rafi-config.yaml"), stringify({ harness: { targets: ["codex"] } }), "utf8");

  assert.equal(resolveAgentForProject(dir), "codex");
  assert.equal(resolveAgentForProject(dir, "claude"), "claude");
});

test("config-derived default agent falls back to Claude for missing or both-target config", () => {
  const dir = mkdtempSync(join(tmpdir(), "foreman-runtime-auth-test-"));
  assert.equal(resolveAgentForProject(dir), "claude");

  writeFileSync(join(dir, "rafi-config.yaml"), stringify({ harness: { targets: ["claude", "codex"] } }), "utf8");
  assert.equal(resolveAgentForProject(dir), "claude");
});

test("runtime command fallback verifies the other runtime and drops model override", async () => {
  const checked: AgentRuntime[] = [];
  let sdkChecks = 0;

  const result = await ensureRuntimeReadyForCommand("/tmp/project", "codex", {
    label: "start",
    model: "gpt-test-model",
    choose: async (_err, context) => {
      assert.equal(context.otherRuntime, "claude");
      assert.equal(context.allowSwitch, true);
      return "switch";
    },
    check: (_projectDir, runtime) => {
      checked.push(runtime);
      if (runtime === "codex") {
        throw new RuntimeAuthError({ runtime, context: "start", stderr: "not logged in" });
      }
    },
    checkClaudeSdk: async () => {
      sdkChecks += 1;
    },
  });

  assert.deepEqual(checked, ["codex", "claude"]);
  assert.equal(sdkChecks, 1);
  assert.deepEqual(result, { runtime: "claude", model: undefined, fellBack: true });
});

test("runtime command fallback is not offered when switching is disabled", async () => {
  const choices: boolean[] = [];

  await assert.rejects(
    ensureRuntimeReadyForCommand("/tmp/project", "claude", {
      label: "start",
      allowSwitch: false,
      choose: async (_err, context) => {
        choices.push(context.allowSwitch);
        return "switch";
      },
      check: (_projectDir, runtime) => {
        throw new RuntimeAuthError({ runtime, context: "start", stderr: "not logged in" });
      },
    }),
    /claude -p failed during start/,
  );

  assert.deepEqual(choices, [false]);
});
