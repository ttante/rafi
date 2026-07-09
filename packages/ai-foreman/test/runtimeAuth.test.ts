import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatRuntimeAuthFailure,
  isRuntimeAuthFailure,
  normalizeRuntimeErrorText,
} from "../src/runtimeAuth.js";

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
