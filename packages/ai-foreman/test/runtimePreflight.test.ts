import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRuntimeEnvironment, runtimePreflightFailure, satisfiesRange } from "../src/runtimePreflight.js";

test("runtime version ranges match Rafi's declared forms", () => {
  assert.equal(satisfiesRange("24.21.0", "24.x"), true);
  assert.equal(satisfiesRange("18.12.1", "24.x"), false);
  assert.equal(satisfiesRange("13.0.3", "^13.0.3"), true);
  assert.equal(satisfiesRange("13.2.0", "^13.0.3"), true);
  assert.equal(satisfiesRange("12.10.0", "^13.0.3"), false, "the stale workspace build that crashed under Node 24");
  assert.equal(satisfiesRange("13.0.2", "^13.0.3"), false);
});

test("the supported test runtime passes every preflight check", () => {
  const checks = checkRuntimeEnvironment();
  assert.ok(checks.some(check => check.label.startsWith("node ")));
  assert.ok(checks.some(check => check.label === "native SQLite loads"));
  assert.equal(runtimePreflightFailure(checks), undefined, JSON.stringify(checks));
  assert.match(runtimePreflightFailure([{ ok: false, label: "node 24.x", detail: "v18.12.1", fix: "use Node 24" }])!, /node 24\.x: v18\.12\.1\n    fix: use Node 24/);
});
