import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkQaPrerequisites } from "../src/qaPrerequisites.js";
import type { TicketDef } from "../src/tickets/ticketSchema.js";
import { boundedQaHistory, utf8Prefix } from "../src/qaHandbackHistory.js";

const ticket = (required_tests: string[]) => ({ id: "T1", required_tests }) as TicketDef;

test("prerequisites are requirement-derived, non-mutating, and distinguish unavailable verification from source defects", async () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-prerequisite-"));
  try {
    const check = (requirements: string[]) => checkQaPrerequisites({ snapshotPath: root, sourceDigest: "source", ticket: ticket(requirements), env: { PATH: root } });
    assert.deepEqual((await check(["Static inspection; Docker is optional"])).checks, []);
    assert.equal((await check(["docker compose run tests"])).checks[0]!.outcome, "not_run");
    writeFileSync(join(root, "pnpm"), "#!/bin/sh\nexit 0\n"); chmodSync(join(root, "pnpm"), 0o755);
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { fixture: "1" } }));
    const missing = await check(["pnpm test", "pnpm install --frozen-lockfile"]);
    assert.ok(missing.checks.some(check => check.capability === "project-dependencies" && check.outcome === "not_run"));
    assert.match(missing.sourceDefects[0]!, /pnpm-lock.yaml/);
    mkdirSync(join(root, "node_modules")); writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    const installed = await check(["pnpm test"]);
    assert.ok(installed.checks.every(check => check.outcome === "available"));
    assert.notEqual(installed.scopeDigest, missing.scopeDigest);
    const changedSandbox = await checkQaPrerequisites({ snapshotPath: root, sourceDigest: "source", ticket: ticket(["pnpm test"]), env: { PATH: root }, runtimeContext: { network: "disabled" } });
    assert.notEqual(changedSandbox.scopeDigest, installed.scopeDigest);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("required service/connectivity checks are bounded; offline/static projects do not probe the network", async () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-prerequisite-bound-"));
  try {
    writeFileSync(join(root, "docker"), "#!/bin/sh\nexit 0\n"); chmodSync(join(root, "docker"), 0o755);
    let networkCalls = 0;
    const input = { snapshotPath: root, sourceDigest: "source", env: { PATH: root }, timeoutMs: 15,
      probe: async () => new Promise<boolean>(() => {}), connectivity: async () => { networkCalls++; throw new Error("permission denied"); } };
    const staticEvidence = await checkQaPrerequisites({ ...input, ticket: ticket(["Review source offline"]) });
    assert.equal(networkCalls, 0); assert.equal(staticEvidence.checks.length, 0);
    const result = await checkQaPrerequisites({ ...input, ticket: ticket(["docker info", "requires connectivity https://registry.invalid"]) });
    assert.equal(result.checks.filter(check => check.outcome === "not_run").length, 2);
    assert.equal(networkCalls, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("optional history is bounded through 20 cycles without recursively copying reports or requests", () => {
  const history: unknown[] = [];
  const sizes: number[] = [];
  for (let cycle = 1; cycle <= 20; cycle++) {
    history.push({ cycle, attemptId: `review-${cycle}`, outcome: "qa_fail", detail: "same unresolved issue", report: { findings: ["required full report lives in current evidence"] }, remediationRequest: JSON.stringify(history), fixSummary: "No progress 🐢" });
    const projection = boundedQaHistory(history);
    const text = JSON.stringify(projection);
    assert.ok(projection.length <= 4);
    assert.doesNotMatch(text, /remediationRequest|findings/);
    sizes.push(Buffer.byteLength(text));
    // Avoid making the test itself exponentially large: old requests are never input authority.
    (history.at(-1) as { remediationRequest: string }).remediationRequest = "nested historical request";
  }
  assert.ok(sizes[19]! <= sizes[3]! + 30);
  assert.equal(utf8Prefix("🐢🐢", 5), "🐢");
  assert.equal(utf8Prefix("a🐢", 4), "a");
});
