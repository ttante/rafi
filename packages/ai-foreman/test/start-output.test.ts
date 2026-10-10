import { test } from "node:test";
import assert from "node:assert/strict";

import { formatResumeGuidance, formatStartResumeCommand } from "../src/cli/start.js";

test("standalone Foreman resume guidance includes the subcommand, project, steps, and session", () => {
  assert.equal(
    formatStartResumeCommand("ai-foreman", "/tmp/project", 1, "session-456"),
    "ai-foreman start /tmp/project --steps 1 --resume session-456",
  );
});

test("Rafi advertises the flag-free resume picker", () => {
  assert.deepEqual(
    formatResumeGuidance("rafi", "/tmp/example project", 3, "session-123"),
    [
      "foreman: resume this run with:",
      "  rafi resume '/tmp/example project'",
    ],
  );
  assert.deepEqual(
    formatResumeGuidance("rafi", "/tmp/project", 1),
    [
      "foreman: resume this run with:",
      "  rafi resume /tmp/project",
    ],
  );
});

test("standalone Foreman omits unusable resume guidance without a session ID", () => {
  assert.deepEqual(formatResumeGuidance("ai-foreman", "/tmp/project", 1), []);
});


test("durable run guidance lists concrete choices and exact-run recovery for either executable", () => {
  for (const executable of ["rafi", "ai-foreman"] as const) {
    const lines = formatResumeGuidance(executable, "/tmp/project", 1, "old-session", {
      runId: "run-1", decisions: [{ decisionId: "decision-1", prompt: "Continue?", choices: [{ id: "continue", label: "Continue" }] }],
    }).join("\n");
    assert.match(lines, /input required: Continue\?/);
    assert.match(lines, /  Continue\n/);
    assert.ok(lines.includes(`${executable} build:decide /tmp/project --run run-1 --decision decision-1 --choice continue`));
    assert.ok(lines.includes(executable === "rafi" ? "rafi resume /tmp/project --run run-1" : "ai-foreman manager /tmp/project --run run-1"));
    assert.doesNotMatch(lines, /old-session/);
  }
});
