import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyClaudeSdkFailure, classifyRuntimeFailure, formatRuntimeProbeFailure, probeRuntime, sanitizeDiagnostics } from "../src/runtimeReadiness.js";

test("runtime failures are phase-aware and login guidance is authentication-only", () => {
  assert.equal(classifyRuntimeFailure("401 not logged in"), "authentication");
  assert.equal(classifyRuntimeFailure("429 rate limit exceeded"), "rate-limit");
  assert.equal(classifyRuntimeFailure("getaddrinfo ENOTFOUND"), "network");
  assert.equal(classifyRuntimeFailure("bad compiler", "compiler-update"), "compiler-update");
  const auth = formatRuntimeProbeFailure({ ok: false, runtime: "claude", phase: "readiness", category: "authentication", executable: "claude", cwd: "/tmp", timedOut: false, exitCode: 1, signal: null, diagnostics: "not logged in", environmentNames: [], recoveryChoices: ["retry", "switch", "cancel"] });
  const network = formatRuntimeProbeFailure({ ok: false, runtime: "claude", phase: "readiness", category: "network", executable: "claude", cwd: "/tmp", timedOut: false, exitCode: 1, signal: null, diagnostics: "network down", environmentNames: [], recoveryChoices: ["retry", "switch", "cancel"] });
  assert.match(auth, /approved by your organization/);
  assert.doesNotMatch(auth, /--claudeai|setup-token|auth logout/);
  assert.doesNotMatch(network, /approved by your organization/);
});

test("runtime probe reports the absolute executable actually invoked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "foreman-runtime-path-"));
  const executable = join(dir, "claude");
  writeFileSync(executable, "#!/bin/sh\nprintf OK\n", "utf8");
  chmodSync(executable, 0o755);
  const result = await probeRuntime(dir, "claude", { env: { PATH: dir }, timeoutMs: 2_000 });
  assert.equal(result.ok, true);
  assert.equal(result.executable, executable);
});

test("structured Claude SDK failures take precedence over vague API text", () => {
  assert.equal(classifyClaudeSdkFailure("authentication_failed", null, "API Error"), "authentication");
  assert.equal(classifyClaudeSdkFailure("oauth_org_not_allowed", 403, "API Error"), "authorization");
  assert.equal(classifyClaudeSdkFailure("rate_limit", 429, "API Error"), "rate-limit");
  assert.equal(classifyClaudeSdkFailure("model_not_found", 400, "API Error"), "configuration");
  assert.equal(classifyClaudeSdkFailure(undefined, 407, "API Error"), "network");
});

test("runtime diagnostics remove ANSI and secrets and enforce the byte cap", () => {
  const value = sanitizeDiagnostics(`\u001b[31merror\u001b[0m token=sk_${"a".repeat(80)} ${"x".repeat(20_000)}`, 512);
  assert.doesNotMatch(value, /\u001b/);
  assert.doesNotMatch(value, /sk_a/);
  assert.ok(Buffer.byteLength(value) <= 512);
  assert.match(value, /<redacted>/);
});
