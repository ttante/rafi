import { test } from "node:test";
import assert from "node:assert/strict";

import { formatResumeGuidance, formatStartResumeCommand } from "../src/cli/start.js";

test("standalone Foreman resume guidance includes the subcommand, project, steps, and session", () => {
  assert.equal(
    formatStartResumeCommand("ai-foreman", "/tmp/project", 1, "session-456"),
    "ai-foreman start /tmp/project --steps 1 --resume session-456",
  );
});

test("Rafi advertises only the canonical build recovery command", () => {
  assert.deepEqual(
    formatResumeGuidance("rafi", "/tmp/example project", 3, "session-123"),
    [
      "foreman: resume this run with:",
      "  rafi build:resume '/tmp/example project'",
    ],
  );
  assert.deepEqual(
    formatResumeGuidance("rafi", "/tmp/project", 1),
    [
      "foreman: resume this run with:",
      "  rafi build:resume /tmp/project",
    ],
  );
});

test("standalone Foreman omits unusable resume guidance without a session ID", () => {
  assert.deepEqual(formatResumeGuidance("ai-foreman", "/tmp/project", 1), []);
});
