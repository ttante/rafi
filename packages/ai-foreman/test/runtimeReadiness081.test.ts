import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRuntimeFailure, formatRuntimeProbeFailure, sanitizeDiagnostics } from "../src/runtimeReadiness.js";

test("runtime failures are phase-aware and login guidance is authentication-only", () => {
  assert.equal(classifyRuntimeFailure("401 not logged in"), "authentication");
  assert.equal(classifyRuntimeFailure("429 rate limit exceeded"), "rate-limit");
  assert.equal(classifyRuntimeFailure("getaddrinfo ENOTFOUND"), "network");
  assert.equal(classifyRuntimeFailure("bad compiler", "compiler-update"), "compiler-update");
  const auth = formatRuntimeProbeFailure({ ok: false, runtime: "claude", phase: "readiness", category: "authentication", executable: "claude", cwd: "/tmp", timedOut: false, exitCode: 1, signal: null, diagnostics: "not logged in", environmentNames: [], recoveryChoices: ["retry", "switch", "cancel"] });
  const network = formatRuntimeProbeFailure({ ok: false, runtime: "claude", phase: "readiness", category: "network", executable: "claude", cwd: "/tmp", timedOut: false, exitCode: 1, signal: null, diagnostics: "network down", environmentNames: [], recoveryChoices: ["retry", "switch", "cancel"] });
  assert.match(auth, /claude auth login/);
  assert.doesNotMatch(network, /claude auth login/);
});

test("runtime diagnostics remove ANSI and secrets and enforce the byte cap", () => {
  const value = sanitizeDiagnostics(`\u001b[31merror\u001b[0m token=sk_${"a".repeat(80)} ${"x".repeat(20_000)}`, 512);
  assert.doesNotMatch(value, /\u001b/);
  assert.doesNotMatch(value, /sk_a/);
  assert.ok(Buffer.byteLength(value) <= 512);
  assert.match(value, /<redacted>/);
});
