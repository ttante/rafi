import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";
import { resolveAuditLoggingMode } from "../src/cli/start.js";
import { ObservabilityStore } from "../src/observability.js";

test("audit logging mode precedence is CLI, project, environment, default", () => {
  assert.equal(resolveAuditLoggingMode("trace", "off", "summary"), "trace");
  assert.equal(resolveAuditLoggingMode(undefined, "off", "trace"), "off");
  assert.equal(resolveAuditLoggingMode(undefined, undefined, "trace"), "trace");
  assert.equal(resolveAuditLoggingMode(undefined, undefined, undefined), "summary");
  assert.throws(() => resolveAuditLoggingMode("invalid", undefined, undefined), /off, summary, or trace/);
});

test("foreman config accepts audit logging modes and preserves legacy enabled=false", () => {
  const root = mkdtempSync(join(tmpdir(), "foreman-observability-mode-"));
  try {
    writeFileSync(join(root, "foreman.yaml"), "observability:\n  mode: trace\n", "utf8");
    assert.equal(loadConfig(join(root, "foreman.yaml")).observability.mode, "trace");
    writeFileSync(join(root, "foreman.yaml"), "observability:\n  enabled: false\n", "utf8");
    const legacy = loadConfig(join(root, "foreman.yaml")).observability;
    assert.equal(legacy.enabled, false);
    assert.equal(legacy.mode, "off");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("summary mode retains summary behavior while trace mode keeps detail", () => {
  const root = mkdtempSync(join(tmpdir(), "foreman-observability-retention-"));
  try {
    const summary = new ObservabilityStore(root, { config: { mode: "summary", enabled: true }, ensureIgnore: false });
    assert.equal(summary.isSummaryOnly(), true);
    summary.close();
    const trace = new ObservabilityStore(root, { config: { mode: "trace", enabled: true }, ensureIgnore: false });
    assert.equal(trace.isSummaryOnly(), false);
    trace.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
