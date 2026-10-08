import { chmodSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
  const result = await probeRuntime(dir, "claude", { env: { PATH: dir }, timeoutMs: 10_000 });
  assert.equal(result.ok, true, JSON.stringify(result));
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

for (const scenario of ["hung-shutdown", "inherited-stdio", "redirected-stdio-child", "invalid-completion", "cancelled"] as const) test(`readiness ${scenario} remains bounded and cannot turn stdout into success`, async () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-readiness-lifecycle-"));
  try {
    const script = scenario === "inherited-stdio"
      ? "printf 'OK\\n'; /bin/sleep 30 & exit 0"
      : scenario === "redirected-stdio-child" ? "/bin/sh -c 'trap \"\" TERM; /bin/sleep 8; printf alive > orphan-marker; /bin/sleep 2' >/dev/null 2>&1 & printf 'OK\\n'; /bin/sleep 30"
      : scenario === "invalid-completion" ? "printf 'unrelated output\\n'"
      : "printf 'OK\\n'; /bin/sleep 30";
    const executable = join(root, "codex"); writeFileSync(executable, `#!/bin/sh\n${script}\n`); chmodSync(executable, 0o755);
    const controller = new AbortController(); const traces: string[] = [];
    if (scenario === "cancelled") setTimeout(() => controller.abort(), 40);
    const began = performance.now();
    // Leave enough time for the shell to start under workspace-suite load; a
    // 200 ms deadline can kill it before the behavior under test even begins.
    const result = await probeRuntime(root, "codex", { env: { PATH: root }, timeoutMs: scenario === "invalid-completion" ? 5000 : 3000, signal: controller.signal, onTrace: event => traces.push(event.phase) });
    assert.equal(result.ok, false); assert.ok(performance.now() - began < (scenario === "invalid-completion" ? 6500 : 4500));
    assert.ok(traces.includes("spawn")); assert.ok(traces.includes("settled"));
    if (scenario === "invalid-completion") assert.equal(result.category, "malformed-protocol");
    else if (scenario === "cancelled") assert.match(result.diagnostics, /cancelled/);
    else { assert.equal(result.category, "timeout"); assert.ok(traces.includes("output"), `fixture must produce output before timeout: ${JSON.stringify(traces)}`); }
    if (scenario === "redirected-stdio-child") {
      await new Promise(resolve => setTimeout(resolve, 8100));
      assert.equal(existsSync(join(root, "orphan-marker")), false, "owned descendant must not survive just because the parent closed stdio");
      assert.ok(traces.includes("owned-child-cleanup"));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
