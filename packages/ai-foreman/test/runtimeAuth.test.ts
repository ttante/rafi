import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
import { readRoleDefaultsForExecution } from "../src/agentRun.js";

test("runtime auth detection matches 401 credential output", () => {
  assert.equal(isRuntimeAuthFailure("Error: 401 Invalid authentication credentials"), true);
});

test("runtime auth formatter preserves organization-approved Claude login", () => {
  const message = formatRuntimeAuthFailure({
    runtime: "claude",
    context: "builder turn",
    exitCode: 1,
    stderr: "not logged in",
  });

  assert.match(message, /claude -p failed during builder turn/);
  assert.match(message, /approved by your organization/);
  assert.match(message, /login-okta/);
  assert.doesNotMatch(message, /auth logout|--claudeai|setup-token/);
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

test("saved role runtime make is pending until the tracker is fully initialized", () => {
  const dir = mkdtempSync(join(tmpdir(), "foreman-runtime-auth-test-"));
  writeFileSync(join(dir, "rafi-config.yaml"), stringify({
    agent_defaults: {
      version: 1,
      revision: 3,
      roles: {
        planner: { make: "codex", model: "gpt-test", reasoning: "high", fast: true },
      },
    },
  }), "utf8");

  assert.deepEqual(readRoleDefaultsForExecution(dir, "planner"), {
    model: "gpt-test",
    reasoning: "high",
    fast: true,
  });

  mkdirSync(join(dir, ".tickets"), { recursive: true });
  writeFileSync(join(dir, ".tickets", "config.yaml"), "app_name: Test\n", "utf8");
  writeFileSync(join(dir, ".tickets", "tickets.yaml"), "tickets: []\n", "utf8");
  writeFileSync(join(dir, ".tickets", "ticket-state.sqlite"), Buffer.from("SQLite format 3\0"));

  assert.equal(readRoleDefaultsForExecution(dir, "planner")?.make, "codex");
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
      return {
        ok: true,
        runtime,
        phase: "readiness" as const,
        category: "ready" as const,
        executable: "/opt/company/bin/claude",
        cwd: "/tmp/project",
        timedOut: false,
        exitCode: 0,
        signal: null,
        diagnostics: "OK",
        environmentNames: [],
        recoveryChoices: [],
      };
    },
    checkClaudeSdk: async () => {
      sdkChecks += 1;
    },
  });

  assert.deepEqual(checked, ["codex", "claude"]);
  assert.equal(sdkChecks, 1);
  assert.equal(result.runtime, "claude");
  assert.equal(result.model, undefined);
  assert.equal(result.fellBack, true);
  assert.equal(result.executable, "/opt/company/bin/claude");
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

test("runtime command diagnostics preserve an SDK load failure after a successful CLI probe", async () => {
  await assert.rejects(
    ensureRuntimeReadyForCommand("/tmp/project", "claude", {
      label: "planning",
      yes: true,
      check: () => ({
        ok: true,
        runtime: "claude",
        phase: "readiness",
        category: "ready",
        executable: "/opt/company/bin/claude",
        cwd: "/tmp/project",
        timedOut: false,
        exitCode: 0,
        signal: null,
        diagnostics: "OK",
        environmentNames: [],
        recoveryChoices: [],
      }),
      checkClaudeSdk: async () => {
        throw new Error("Rafi's Claude Agent SDK dependency is not installed");
      },
    }),
    (err: unknown) => {
      assert.ok(err instanceof RuntimeAuthError);
      assert.match(err.message, /SDK dependency is not installed/);
      assert.equal(err.authLikely, false);
      return true;
    },
  );
});
