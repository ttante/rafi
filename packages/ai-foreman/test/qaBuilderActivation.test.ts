import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import type { ResolvedAgentSettings, ProviderSessionRefV1 } from "rafi-spec";
import type { BuilderAdapter, BuilderEvent, TurnResult } from "../src/adapters/types.js";
import { activateQaRecoveryBuilder, type QaRecoveryBuilderActivation } from "../src/qaBuilderActivation.js";
import { ContinuityAdapter, baselineContinuityDelta } from "../src/continuity.js";
import { createBuildRun, persistBuildSession, persistCurrentBuildSession, readBuildRuns } from "../src/buildRuns.js";
import { createProviderSessionRef, providerSessionKey } from "../src/sessionIdentity.js";
import { cmdInit } from "../src/tickets/commands.js";
import { WorkflowDb } from "../src/workflowDb.js";

class Adapter implements BuilderAdapter {
  readonly agent = "codex" as const;
  closed = false;
  readonly turns: Array<{ text: string; responseOnly?: boolean }> = [];
  constructor(private ref: ProviderSessionRefV1, private refuse = false) {}
  sessionId() { return this.ref.sessionId; }
  sessionRef() { return this.ref; }
  adoptSessionRef(ref: ProviderSessionRefV1) { this.ref = ref; }
  async sendTurn(text: string, policy?: Parameters<BuilderAdapter["sendTurn"]>[1]): Promise<TurnResult> {
    this.turns.push({ text, responseOnly: policy?.responseOnly });
    return { text: this.refuse ? "I refuse this handoff protocol." : `${policy?.responseOnly ? "HANDOFF_ACCEPTED\n" : "Authorized follow-up inspected current source.\n"}RAFI_CONTINUITY_DELTA: ${JSON.stringify(baselineContinuityDelta("Continue approved work."))}`, isError: false, numTurns: 1, costUsd: 0 };
  }
  async *events(): AsyncIterable<BuilderEvent> {}
  async close() { this.closed = true; }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rafi-qa-builder-owner-"));
  cmdInit(root, {});
  const definition = { id: "T001", order: 1, title: "Approved feature", area: "tests", priority: "P2", size: "XS", risk: "Low", depends_on: [], summary: "Implement approved feature", acceptance: ["Feature works"], required_tests: [], likely_files: ["feature.txt"], notes: "Fixture" };
  writeFileSync(join(root, ".tickets/tickets.yaml"), stringify({ tickets: [definition] }));
  writeFileSync(join(root, "feature.txt"), "Preserved implementation\n");
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git(["init", "-q", "-b", "main"]); git(["config", "user.name", "Fixture"]); git(["config", "user.email", "fixture@example.test"]); git(["add", "."]); git(["commit", "-qm", "Approved baseline"]);
  const settings: ResolvedAgentSettings = { role: "builder", source: "project", make: "codex", model: "default", reasoning: "default", fast: false, session_strategy: "compact", settings_revision: 0, display_session_cost: false, auto_compact_threshold_percent: 65, compact_maximum: 10 };
  const capabilities = { requestedNetwork: false, grantedNetwork: false };
  let run = createBuildRun({ repositoryRoot: root, tickets: [definition.id], builder: settings, builderCapabilities: capabilities });
  const ref = (id: string) => createProviderSessionRef({ provider: "codex", sessionId: id, role: "builder", stream: "builder", cwd: root, configRoot: root, source: "observed", validatedAt: new Date().toISOString() });
  const original = ref("original-owned-builder");
  run = persistBuildSession(root, run, "builder", original);
  const db = new WorkflowDb(root);
  db.admitWork({ runId: run.runId, kind: "ticket", ticketId: definition.id, definition, approvalId: "fixture-approved", scopeRevision: "fixture-scope", provenance: { userTurn: "Implement T001", reason: "Explicit approved fixture scope" } });
  db.claimInitialRoleLease(run.runId, "builder", original);
  db.publishContinuityCheckpoint({ runId: run.runId, role: "builder", delta: baselineContinuityDelta("Await approved follow-up."), authoritativeStateRevision: 0 });
  const placeholder = new Adapter(ref("unused-qa-startup-builder"));
  const successor = new Adapter(ref("validated-followup-builder"));
  let factories = 0;
  const input: QaRecoveryBuilderActivation = {
    projectDir: root, runId: run.runId, ticketId: definition.id, worktree: root, adapter: placeholder, settings: run.builder!.settings,
    expectedCapabilities: capabilities, frozenAction: "Apply the authorized T001 follow-up, inspect preserved files, and require fresh QA.",
    createSuccessor: async () => { factories++; assert.equal(db.roleMutationLease(run.runId, "builder")?.sessionKey, providerSessionKey(original)); return successor; },
    wrap: adapter => new ContinuityAdapter({ adapter, projectDir: root, runId: run.runId, role: "builder", settings: run.builder!.settings }),
    recovery: { choose: async () => "pause" },
  };
  return { root, run, definition, db, original, placeholder, successor, input, factories: () => factories, close() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("QA-only startup leaves Builder ownership untouched; an actual follow-up accepts a fresh owner and dispatches through real continuity", async () => {
  const f = fixture(); let owned: BuilderAdapter | undefined;
  try {
    assert.equal(f.factories(), 0); assert.equal(f.placeholder.turns.length, 0);
    assert.equal(f.db.roleMutationLease(f.run.runId, "builder")?.sessionKey, providerSessionKey(f.original));
    owned = await activateQaRecoveryBuilder(f.input);
    assert.equal(f.factories(), 1); assert.equal(f.placeholder.closed, true);
    assert.equal(f.successor.turns.length, 1); assert.equal(f.successor.turns[0]!.responseOnly, true);
    assert.equal(f.db.roleMutationLease(f.run.runId, "builder")?.sessionKey, providerSessionKey(f.successor.sessionRef()));
    const projection = readBuildRuns(f.root).find(run => run.runId === f.run.runId)!;
    assert.throws(() => persistCurrentBuildSession(f.root, projection, "builder", owned!.sessionRef!()!), /original workflow authority/);
    f.db.transition(f.run.runId, { checkpoint: "qa-activation-current-state", state: { ...f.db.getRun(f.run.runId)!.state, currentTicket: "T001", runDecisions: { ...f.run.runDecisions, dirtyWork: "preserve" } } });
    const published = persistCurrentBuildSession(f.root, f.run, "builder", owned.sessionRef!()!);
    assert.equal(published.builder!.sessionId, f.successor.sessionId());
    assert.equal(published.runDecisions?.dirtyWork, "preserve", "publication must preserve intervening durable state");
    const result = await owned.sendTurn("Apply the authorized follow-up to T001.");
    assert.equal(result.isError, false); assert.equal(f.successor.turns.length, 2);
    assert.equal(f.db.unresolvedRoleDispatches(f.run.runId, "builder").length, 0);
    assert.equal(f.db.operations(f.run.runId).filter(op => op.kind === "provider-dispatch" && op.status === "confirmed").length, 1);
    assert.equal(await activateQaRecoveryBuilder({ ...f.input, adapter: owned }), owned, "Repeated boundary checks must not create another handoff");
    assert.equal(f.factories(), 1);
  } finally { await owned?.close(); f.close(); }
});

test("activated session publication refuses lost or renewed execution authority", () => {
  const f = fixture();
  try {
    const before = readBuildRuns(f.root).find(run => run.runId === f.run.runId)!;
    f.db.releaseLease(f.db.currentLease()!);
    assert.throws(() => persistCurrentBuildSession(f.root, f.run, "builder", f.successor.sessionRef()), /workflow lease ownership changed/);
    f.db.acquireLease(f.run.runId);
    assert.throws(() => persistCurrentBuildSession(f.root, f.run, "builder", f.successor.sessionRef()), /workflow lease ownership changed/);
    assert.equal(readBuildRuns(f.root).find(run => run.runId === f.run.runId)!.builder!.sessionId, before.builder!.sessionId);
  } finally { const lease=f.db.currentLease(); if(lease)f.db.releaseLease(lease); f.close(); }
});

test("a matching session key with the wrong native generation cannot bypass validated ownership transfer", async () => {
  const f = fixture();
  const wrongGeneration = new Adapter({ ...f.original, generation: f.original.generation + 1 });
  let owned: BuilderAdapter | undefined;
  try {
    assert.equal(providerSessionKey(wrongGeneration.sessionRef()), providerSessionKey(f.original));
    owned = await activateQaRecoveryBuilder({ ...f.input, adapter: wrongGeneration });
    assert.notEqual(owned, wrongGeneration);
    assert.equal(f.factories(), 1);
    assert.equal(wrongGeneration.turns.length, 0);
    assert.equal(wrongGeneration.closed, true);
    assert.equal(f.successor.turns[0]?.responseOnly, true);
    assert.equal(f.db.roleMutationLease(f.run.runId, "builder")?.sessionKey, providerSessionKey(f.successor.sessionRef()));
  } finally { await owned?.close(); f.close(); }
});

test("rejected acceptance preserves the original owner and closes no placeholder before a successful handoff", async () => {
  const f = fixture(); const rejected = new Adapter({ ...f.successor.sessionRef(), sessionId: "rejecting-successor" }, true);
  try {
    await assert.rejects(activateQaRecoveryBuilder({ ...f.input, createSuccessor: async () => rejected }), /handoff|paused|refus/i);
    assert.equal(f.db.roleMutationLease(f.run.runId, "builder")?.sessionKey, providerSessionKey(f.original));
    assert.equal(f.placeholder.closed, false); assert.equal(f.placeholder.turns.length, 0);
    assert.equal(readFileSync(join(f.root, "feature.txt"), "utf8"), "Preserved implementation\n");
  } finally { await rejected.close(); f.close(); }
});

test("source changes during successor creation stop acceptance and retain the original owner", async () => {
  const f = fixture();
  try {
    await assert.rejects(activateQaRecoveryBuilder({ ...f.input, createSuccessor: async () => {
      writeFileSync(join(f.root, "feature.txt"), "Concurrent uninspected source\n");
      return f.successor;
    } }), /state changed/);
    assert.equal(f.successor.closed, true); assert.equal(f.successor.turns.length, 0);
    assert.equal(f.placeholder.closed, false);
    assert.equal(f.db.roleMutationLease(f.run.runId, "builder")?.sessionKey, providerSessionKey(f.original));
  } finally { f.close(); }
});

for (const fault of ["wrapper", "placeholder-close"] as const) {
  test(`an accepted handoff followed by ${fault} failure drains the successor and preserves its truthful owner`, async () => {
    const f = fixture();
    try {
      if (fault === "placeholder-close") f.placeholder.close = async () => { throw new Error("Injected startup shutdown failure"); };
      await assert.rejects(activateQaRecoveryBuilder({ ...f.input,
        ...(fault === "wrapper" ? { wrap: () => { throw new Error("Injected wrapper failure"); } } : {}),
      }), /handoff recovery paused safely/);
      assert.equal(f.successor.closed, true); assert.equal(f.successor.turns.length, 1);
      assert.equal(f.db.roleMutationLease(f.run.runId, "builder")?.sessionKey, providerSessionKey(f.successor.sessionRef()), "A recorded accepted transfer cannot be rolled back to an obsolete owner");
      assert.equal(f.db.unresolvedRoleDispatches(f.run.runId, "builder").length, 0);
      assert.equal(f.placeholder.turns.length, 0);
    } finally { f.close(); }
  });
}

for (const fault of ["unknown-dispatch", "unreconciled-assignment", "changed-requirements", "changed-branch", "degraded-head", "settings-override", "capability-override"] as const) {
  test(`QA Builder activation rejects ${fault} before creating or moving a successor`, async () => {
    const f = fixture();
    try {
      if (fault === "unknown-dispatch" || fault === "unreconciled-assignment") {
        f.db.planOperation({ runId: f.run.runId, idempotencyKey: "unfinished-work", kind: fault === "unknown-dispatch" ? "provider-dispatch" : "build-assignment", intent: { role: "builder", ticketId: "T001", worktree: f.root, sessionRef: f.original } });
        f.db.updateOperation("unfinished-work", "in_progress");
      }
      if (fault === "changed-requirements") writeFileSync(join(f.root, ".tickets/tickets.yaml"), stringify({ tickets: [{ ...f.definition, acceptance: ["Changed requirement"] }] }));
      if (fault === "changed-branch") execFileSync("git", ["checkout", "-qb", "foreign-branch"], { cwd: f.root, stdio: "pipe" });
      if (fault === "degraded-head") f.db.publishContinuityCheckpoint({ runId: f.run.runId, role: "builder", state: "degraded", delta: baselineContinuityDelta("Reconstruct before work."), authoritativeStateRevision: 0 });
      const input = { ...f.input, ...(fault === "settings-override" ? { settings: { ...f.input.settings, make: "claude" as const } } : {}), ...(fault === "capability-override" ? { expectedCapabilities: { requestedNetwork: true, grantedNetwork: true } } : {}) };
      await assert.rejects(activateQaRecoveryBuilder(input), /unknown|reconciliation|requirements|branch|continuity|settings|capability/i);
      assert.equal(f.factories(), 0); assert.equal(f.placeholder.closed, false);
      assert.equal(f.db.roleMutationLease(f.run.runId, "builder")?.sessionKey, providerSessionKey(f.original));
    } finally { f.close(); }
  });
}
