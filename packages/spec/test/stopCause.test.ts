import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStopCause, stopCause } from "../src/stopCause.js";

test("stop causes are closed, typed, and preserve signal distinctions", () => {
  const sigint = stopCause({ cause: "user-sigint", source: "signal", actor: "user", runId: "run", checkpoint: "worker-interrupted", at: new Date(0).toISOString(), requested: true });
  const sigterm = stopCause({ cause: "parent-sigterm", source: "signal", actor: "parent", runId: "run", checkpoint: "worker-interrupted", at: new Date(0).toISOString(), requested: true });
  assert.equal(sigint.cause, "user-sigint");
  assert.equal(sigterm.cause, "parent-sigterm");
  assert.throws(() => parseStopCause({ ...sigint, cause: "made-up" }), /Invalid|received/);
  assert.throws(() => parseStopCause({ ...sigint, detail: "x".repeat(2049) }), /maximum/);
});
