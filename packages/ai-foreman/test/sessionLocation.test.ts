import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import type { ContinuityDelta, ProviderSessionRefV1, ResolvedAgentSettings } from "rafi-spec";
import { ClaudeAdapter, probeClaudeSession } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { RecoveringAdapter } from "../src/adapters/recovering.js";
import { SessionUnavailableError } from "../src/adapters/sessionFailure.js";
import type { BuilderAdapter, BuilderAdapterOptions, BuilderEvent, TurnResult } from "../src/adapters/types.js";
import { CurrentWorkflowGuardAdapter, captureCurrentWorkflowSessionIdentity } from "../src/branch/currentGuard.js";
import { buildRunSessionBinding, createBuildRun, persistBuildSession, projectBuildRecovery, releaseBuildLease } from "../src/buildRuns.js";
import { ContinuityAdapter, SessionUnavailableContinuityError } from "../src/continuity.js";
import { HANDOFF_ACCEPTED, HandoffService } from "../src/handoffs.js";
import { compactWithRetry, runIsolatedQa, type QaStreamState } from "../src/qaReview.js";
import { createProviderSessionRef, providerSessionKey, resolveUniqueSessionBinding, validateProviderSessionScope } from "../src/sessionIdentity.js";
import { RoleSessionController, RoleSessionValidationError, ThresholdCompactionController } from "../src/sessionLifecycle.js";
import { WorkflowDb } from "../src/workflowDb.js";

const SETTINGS: ResolvedAgentSettings = {
  role: "builder", source: "project", make: "codex", model: "default", reasoning: "default", fast: false,
  session_strategy: "compact", settings_revision: 1, display_session_cost: false,
  auto_compact_threshold_percent: 50, compact_maximum: 10,
};

class StaticAdapter implements BuilderAdapter {
  readonly agent: "claude" | "codex";
  sends = 0;
  closed = false;

  constructor(
    private readonly id: string | undefined,
    private readonly result: TurnResult,
    private ref?: ProviderSessionRefV1,
    agent: "claude" | "codex" = "codex",
  ) { this.agent = agent; }

  async sendTurn(): Promise<TurnResult> { this.sends += 1; return this.result; }
  sessionId(): string | undefined { return this.id; }
  sessionRef(): ProviderSessionRefV1 | undefined { return this.ref; }
  adoptSessionRef(ref: ProviderSessionRefV1): void { this.ref = ref; }
  async *events(): AsyncIterable<BuilderEvent> {}
  async close(): Promise<void> { this.closed = true; }
}

function temp(prefix: string): string { return mkdtempSync(join(tmpdir(), prefix)); }

function scopedRef(provider: "claude" | "codex", cwd: string, sessionId = "same-id", configRoot = cwd): ProviderSessionRefV1 {
  return createProviderSessionRef({
    provider, sessionId, role: "builder", stream: "builder", cwd, configRoot, source: "observed",
  });
}

test("provider session scope accepts only the original canonical directory identity", () => {
  const root = temp("rafi-session-scope-");
  const original = join(root, "original");
  const other = join(root, "other");
  mkdirSync(original);
  mkdirSync(other);
  execFileSync("git", ["init", "-q"], { cwd: original });
  execFileSync("git", ["init", "-q"], { cwd: other });
  const ref = scopedRef("codex", original, "thread-1", root);

  assert.equal(validateProviderSessionScope(ref, {
    provider: "codex", cwd: original, configRoot: root, role: "builder", stream: "builder",
  }).status, "available");
  assert.equal(validateProviderSessionScope(ref, {
    provider: "codex", cwd: other, configRoot: root, role: "builder", stream: "builder",
  }).reason, "cwd-mismatch");

  rmSync(original, { recursive: true, force: true });
  assert.equal(validateProviderSessionScope(ref, {
    provider: "codex", cwd: original, configRoot: root, role: "builder", stream: "builder",
  }).reason, "not-found");
  mkdirSync(original);
  execFileSync("git", ["init", "-q"], { cwd: original });
  assert.equal(validateProviderSessionScope(ref, {
    provider: "codex", cwd: original, configRoot: root, role: "builder", stream: "builder",
  }).reason, "workspace-mismatch");
});

test("scoped session keys separate the same provider ID across worktrees", () => {
  const root = temp("rafi-session-key-");
  const left = join(root, "left");
  const right = join(root, "right");
  mkdirSync(left);
  mkdirSync(right);
  execFileSync("git", ["init", "-q"], { cwd: left });
  execFileSync("git", ["init", "-q"], { cwd: right });
  const leftRef = scopedRef("codex", left, "duplicate", root);
  const rightRef = scopedRef("codex", right, "duplicate", root);
  assert.notEqual(providerSessionKey(leftRef), providerSessionKey(rightRef));

  const db = new WorkflowDb(root);
  for (const [idempotencyKey, ref] of [["left", leftRef], ["right", rightRef]] as const) {
    db.startCompactionAttempt({ idempotencyKey, runId: "run-1", role: "builder", providerSessionId: ref.sessionId, sessionRef: ref, crossingKey: idempotencyKey });
    db.finishCompactionAttempt(idempotencyKey, { ok: true });
  }
  assert.equal(db.successfulCompactionCount("run-1", "builder", leftRef), 1);
  assert.equal(db.successfulCompactionCount("run-1", "builder", rightRef), 1);
  assert.equal(db.successfulCompactionCount("run-1", "builder", "duplicate"), 0, "a bare legacy ID must not absorb scoped rows");
  db.recordProviderSessionBinding(leftRef);
  db.recordProviderSessionBinding(rightRef);
  const bindings = db.providerSessionBindings("duplicate", "builder");
  assert.equal(bindings.length, 2);
  assert.throws(() => resolveUniqueSessionBinding(bindings, "duplicate"), /ambiguous across recorded locations/);
  db.close();
});

test("Claude availability distinguishes available, missing, mismatched cwd, and probe errors", async () => {
  const root = temp("rafi-claude-probe-");
  const cwd = join(root, "worktree");
  const other = join(root, "other");
  mkdirSync(cwd);
  mkdirSync(other);
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["init", "-q"], { cwd: other });
  const ref = scopedRef("claude", cwd, "claude-session", root);
  const info = (sessionId: string, observedCwd: string): SDKSessionInfo => ({ sessionId, cwd: observedCwd } as SDKSessionInfo);

  assert.equal((await probeClaudeSession(ref, { cwd, configRoot: root, getSessionInfo: async () => info(ref.sessionId, cwd) })).status, "available");
  assert.equal((await probeClaudeSession(ref, { cwd, configRoot: root, getSessionInfo: async () => undefined })).reason, "not-found");
  assert.equal((await probeClaudeSession(ref, { cwd, configRoot: root, getSessionInfo: async () => info(ref.sessionId, other) })).reason, "cwd-mismatch");
  assert.equal((await probeClaudeSession(ref, { cwd, configRoot: root, getSessionInfo: async () => { throw new Error("metadata service failed"); } })).reason, "probe-failed");
});

test("Claude missing-conversation stream failure settles one pending turn exactly once", async () => {
  const cwd = temp("rafi-claude-stream-");
  const ref = scopedRef("claude", cwd, "missing-session");
  const queryObject = (async function* () {
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    throw new Error("No conversation found with session ID missing-session");
  })() as AsyncGenerator<never> & { interrupt(): Promise<void>; getContextUsage(): Promise<{ totalTokens: number; maxTokens: number; percentage: number }> };
  queryObject.interrupt = async () => {};
  queryObject.getContextUsage = async () => ({ totalTokens: 0, maxTokens: 100, percentage: 0 });
  const Constructor = ClaudeAdapter as unknown as new (
    opts: BuilderAdapterOptions,
    query: (input: unknown) => typeof queryObject,
  ) => ClaudeAdapter;
  const adapter = new Constructor({ cwd, configRoot: cwd, resumeSessionRef: ref, permission: async () => ({ behavior: "deny", message: "no tools" }) }, () => queryObject);
  const events: BuilderEvent[] = [];
  const eventPump = (async () => { for await (const event of adapter.events()) events.push(event); })();
  const result = await Promise.race([
    adapter.sendTurn("do not hang"),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("turn hung")), 1_000)),
  ]);
  await eventPump;
  assert.equal(result.failure?.category, "session-unavailable");
  assert.equal(result.failure?.dispatchState, "unknown");
  assert.equal(events.filter((event) => event.kind === "turn-complete").length, 1);
  assert.equal((await adapter.sendTurn("must not replay")).failure?.category, "session-unavailable");
  await adapter.close();
});

test("Codex exact validation attaches with thread/resume and never starts a turn", async () => {
  const root = temp("rafi-codex-probe-");
  const cwd = join(root, "worktree");
  mkdirSync(cwd);
  execFileSync("git", ["init", "-q"], { cwd });
  const ref = scopedRef("codex", cwd, "thread-1", root);
  const adapter = new CodexAdapter({ cwd, configRoot: root, resumeSessionRef: ref, permission: async () => ({ behavior: "deny", message: "probe" }) });
  const methods: string[] = [];
  const internal = adapter as unknown as {
    ensureConnection(): Promise<void>;
    request(method: string, params: Record<string, unknown>): Promise<unknown>;
  };
  internal.ensureConnection = async () => {};
  internal.request = async (method) => {
    methods.push(method);
    return { thread: { id: ref.sessionId, cwd } };
  };
  const availability = await adapter.validateSession();
  assert.equal(availability.status, "available");
  assert.deepEqual(methods, ["thread/resume"]);
  assert.equal(methods.includes("turn/start"), false);
  await adapter.close();
});

test("Codex exact validation rejects attachment to a different returned thread", async () => {
  const root = temp("rafi-codex-wrong-thread-");
  const cwd = join(root, "worktree");
  mkdirSync(cwd);
  execFileSync("git", ["init", "-q"], { cwd });
  const ref = scopedRef("codex", cwd, "thread-requested", root);
  const adapter = new CodexAdapter({ cwd, configRoot: root, resumeSessionRef: ref, permission: async () => ({ behavior: "deny", message: "probe" }) });
  const methods: string[] = [];
  const internal = adapter as unknown as {
    ensureConnection(): Promise<void>;
    request(method: string, params: Record<string, unknown>): Promise<unknown>;
  };
  internal.ensureConnection = async () => {};
  internal.request = async (method) => {
    methods.push(method);
    return { thread: { id: "thread-other", cwd } };
  };
  const availability = await adapter.validateSession();
  assert.equal(availability.status, "unavailable");
  assert.equal(availability.reason, "attach-failed");
  assert.match(availability.detail ?? "", /instead of requested thread/);
  assert.deepEqual(methods, ["thread/resume"]);
  await adapter.close();
});

test("RecoveringAdapter never replays or switches a session-unavailable turn", async () => {
  const cwd = temp("rafi-no-replay-");
  const failure = new SessionUnavailableError({
    runtime: "codex", phase: "turn", dispatchState: "unknown", executable: "codex", cwd,
    diagnostics: "thread disappeared",
  });
  const initial = new StaticAdapter("thread-1", {
    text: failure.message, isError: true, numTurns: 0, costUsd: 0, failure: failure.failure,
  });
  let choices = 0;
  let recreates = 0;
  const recovering = new RecoveringAdapter({
    initial, runtime: "codex", enabled: true, allowSwitch: true, label: "test",
    choose: async () => { choices += 1; return "retry"; },
    recreate: async () => { recreates += 1; return initial; },
  });
  const result = await recovering.sendTurn("one uncertain instruction");
  assert.equal(result.failure?.category, "session-unavailable");
  assert.equal(initial.sends, 1);
  assert.equal(choices, 0);
  assert.equal(recreates, 0);
  await recovering.close();
});

test("role lifecycle authorizes exact attachment only after scoped validation", async () => {
  const cwd = temp("rafi-role-session-validation-");
  execFileSync("git", ["init", "-q"], { cwd });
  const ref = scopedRef("codex", cwd, "thread-1");
  const provider = new StaticAdapter(ref.sessionId, { text: "", isError: false, numTurns: 0, costUsd: 0 }, ref) as StaticAdapter & {
    validateSession(): Promise<{ version: 1; status: "unavailable"; checkedAt: string; reason: "not-found"; sessionRef: ProviderSessionRefV1 }>;
  };
  provider.validateSession = async () => ({
    version: 1, status: "unavailable", checkedAt: new Date().toISOString(), reason: "not-found", sessionRef: ref,
  });
  const controller = new RoleSessionController({
    role: "builder", settings: SETTINGS, initialSessionRef: ref, create: async () => provider,
  });
  await assert.rejects(controller.next("resume"), RoleSessionValidationError);
  assert.equal(provider.closed, true);

  let rawCreates = 0;
  const raw = new RoleSessionController({
    role: "builder", settings: SETTINGS, initialSessionId: "raw-only", create: async () => { rawCreates += 1; return provider; },
  });
  await assert.rejects(raw.next("resume"), /raw provider session ID has no verifiable location scope/);
  assert.equal(rawCreates, 0);

  const managed = RoleSessionController.managed({
    projectDir: cwd,
    runId: "run-managed",
    role: "builder",
    initialSettings: SETTINGS,
  });
  const unscopedLive = new StaticAdapter("raw-live", { text: "", isError: false, numTurns: 0, costUsd: 0 });
  await assert.rejects(managed.atSafeBoundary(unscopedLive, "frozen action"), RoleSessionValidationError);
});

test("continuity does not issue a repair turn after uncertain exact-session loss", async () => {
  const projectDir = temp("rafi-continuity-session-loss-");
  const failure = new SessionUnavailableError({
    runtime: "claude", phase: "turn", dispatchState: "unknown", executable: "claude", cwd: projectDir,
    diagnostics: "No conversation found with session ID session-1",
  });
  const provider = new StaticAdapter("session-1", {
    text: failure.message, isError: true, numTurns: 0, costUsd: 0, failure: failure.failure,
  });
  const adapter = new ContinuityAdapter({ adapter: provider, projectDir, runId: "run-1", role: "builder", settings: SETTINGS });
  await assert.rejects(adapter.sendTurn("one side effect"), (error: unknown) => {
    assert.ok(error instanceof SessionUnavailableContinuityError);
    assert.equal(error.guidedRecovery, true);
    return true;
  });
  assert.equal(provider.sends, 1, "continuity repair must not replay an uncertain turn");
  const db = new WorkflowDb(projectDir);
  assert.equal(db.continuityHead("run-1", "builder")?.state, "degraded");
  assert.equal(db.continuityEvents("run-1").at(-1)?.kind, "session_unavailable");
  db.close();
  await adapter.close();
});

test("pre-dispatch exact-session loss pauses without degrading or issuing a repair", async () => {
  const projectDir = temp("rafi-continuity-attach-loss-");
  const failure = new SessionUnavailableError({
    runtime: "codex", phase: "attach", dispatchState: "not-sent", executable: "codex", cwd: projectDir,
    diagnostics: "thread not found",
  });
  const provider = new StaticAdapter("thread-1", {
    text: failure.message, isError: true, numTurns: 0, costUsd: 0, failure: failure.failure,
  });
  const adapter = new ContinuityAdapter({ adapter: provider, projectDir, runId: "run-1", role: "builder", settings: SETTINGS });
  await assert.rejects(adapter.sendTurn("safe to transfer later"), (error: unknown) => {
    assert.ok(error instanceof SessionUnavailableContinuityError);
    assert.equal(error.guidedRecovery, false);
    return true;
  });
  assert.equal(provider.sends, 1);
  const db = new WorkflowDb(projectDir);
  assert.equal(db.continuityHead("run-1", "builder")?.state, "current");
  db.close();
  await adapter.close();
});

test("accepted handoff promotes the live and durable successor generation together", async () => {
  const projectDir = temp("rafi-handoff-generation-");
  execFileSync("git", ["init", "-q"], { cwd: projectDir });
  const predecessorRef = scopedRef("codex", projectDir, "thread-1");
  const successorRef = scopedRef("codex", projectDir, "thread-2");
  const delta: ContinuityDelta = {
    version: 1, decisions: [], constraints: [], discoveries: [], completedActions: [], evidence: [], failures: [], blockers: [], openWork: ["continue"], nextAction: "continue",
  };
  const db = new WorkflowDb(projectDir);
  db.ensureRun("run-1");
  db.appendContinuityEvent({ runId: "run-1", role: "host", kind: "baseline", payload: {}, authoritativeStateRevision: 1, sessionRef: predecessorRef });
  db.publishContinuityCheckpoint({ runId: "run-1", role: "builder", delta, authoritativeStateRevision: 1, sessionRef: predecessorRef });
  db.claimInitialRoleLease("run-1", "builder", predecessorRef);
  db.close();
  const successor = new StaticAdapter("thread-2", {
    text: `${HANDOFF_ACCEPTED}\nRAFI_CONTINUITY_DELTA: ${JSON.stringify(delta)}`,
    isError: false, numTurns: 1, costUsd: 0,
  }, successorRef);
  const transfer = await new HandoffService(projectDir).transfer({
    runId: "run-1", role: "builder", reason: "generation test",
    predecessorSessionId: predecessorRef.sessionId, predecessorSessionRef: predecessorRef,
    compactionCount: 0, compactMaximum: 10,
  }, async () => successor);
  assert.equal(transfer.manifest.generation, 1);
  assert.equal(transfer.successor.sessionRef?.()?.generation, 1);
  assert.ok(transfer.successor.sessionRef?.()?.validatedAt);
  const after = new WorkflowDb(projectDir);
  assert.equal(after.roleMutationLease("run-1", "builder")?.generation, 1);
  assert.equal(after.roleMutationLease("run-1", "builder")?.sessionRef?.generation, 1);
  after.close();
});

test("compactWithRetry converts thrown adapter failures into an explicit result", async () => {
  const adapter = new StaticAdapter("thread-1", { text: "", isError: false, numTurns: 0, costUsd: 0 }) as StaticAdapter & { compact(): Promise<{ ok: boolean; error?: string }> };
  let calls = 0;
  adapter.compact = async () => { calls += 1; throw new Error("transport exploded"); };
  assert.deepEqual(await compactWithRetry(adapter), { ok: false, error: "transport exploded" });
  assert.equal(calls, 2);
});

test("session loss during compaction degrades continuity and never hands off automatically", async () => {
  const projectDir = temp("rafi-compaction-session-loss-");
  execFileSync("git", ["init", "-q"], { cwd: projectDir });
  const ref = scopedRef("codex", projectDir, "thread-1");
  const failure = new SessionUnavailableError({
    runtime: "codex", phase: "turn", dispatchState: "unknown", executable: "codex", cwd: projectDir,
    diagnostics: "thread disappeared during compaction",
    availability: { version: 1, status: "unknown", checkedAt: new Date().toISOString(), reason: "probe-failed", sessionRef: ref },
  });
  const adapter = new StaticAdapter(ref.sessionId, { text: "", isError: false, numTurns: 0, costUsd: 0 }, ref) as StaticAdapter & {
    compact(): Promise<{ ok: boolean; error?: string; failure?: typeof failure.failure }>;
    contextUsage(): Promise<{ used: number; maximum: number; percentage: number }>;
  };
  let compactCalls = 0;
  adapter.compact = async () => { compactCalls += 1; return { ok: false, error: failure.message, failure: failure.failure }; };
  adapter.contextUsage = async () => ({ used: 80, maximum: 100, percentage: 80 });
  const db = new WorkflowDb(projectDir);
  db.ensureRun("run-1");
  db.appendContinuityEvent({ runId: "run-1", role: "host", kind: "baseline", payload: {}, authoritativeStateRevision: 1, sessionRef: ref });
  db.publishContinuityCheckpoint({ runId: "run-1", role: "builder", delta: {
    version: 1, decisions: [], constraints: [], discoveries: [], completedActions: [], evidence: [], failures: [], blockers: [], openWork: ["continue"], nextAction: "continue",
  }, authoritativeStateRevision: 1, sessionRef: ref });
  db.close();
  let handoffs = 0;
  const controller = new ThresholdCompactionController({
    projectDir, runId: "run-1", role: "builder", initialSettings: SETTINGS,
    handoff: async () => { handoffs += 1; return adapter; },
  });
  await assert.rejects(controller.atSafeBoundary(adapter, "frozen action"), SessionUnavailableError);
  assert.equal(compactCalls, 1);
  assert.equal(handoffs, 0);
  const after = new WorkflowDb(projectDir);
  assert.equal(after.continuityHead("run-1", "builder")?.state, "degraded");
  assert.equal(after.continuityEvents("run-1").at(-1)?.kind, "session_unavailable");
  after.close();
  assert.equal((await compactWithRetry(adapter)).failure?.category, "session-unavailable");
  assert.equal(compactCalls, 2, "typed session loss is returned without a second retry");
});

test("each disposable QA cycle creates a fresh provider session in a different snapshot cwd", async () => {
  const projectDir = temp("rafi-qa-fresh-");
  execFileSync("git", ["init", "-q"], { cwd: projectDir });
  execFileSync("git", ["config", "user.email", "qa@example.test"], { cwd: projectDir });
  execFileSync("git", ["config", "user.name", "QA Test"], { cwd: projectDir });
  writeFileSync(join(projectDir, "README.md"), "base\n");
  execFileSync("git", ["add", "README.md"], { cwd: projectDir });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: projectDir });
  const cws: string[] = [];
  const resumeIds: Array<string | undefined> = [];
  const observedQaSessions: string[] = [];
  let created = 0;
  const state: QaStreamState = { reviews: 0, modificationViolations: 0 };
  const result = await runIsolatedQa({
    ticket: {
      id: "T001", order: 1000, title: "Fresh QA", area: "test", priority: "P1", size: "S", risk: "Low",
      depends_on: [], summary: "Verify QA isolation", acceptance: ["isolated"], required_tests: ["test"], likely_files: ["README.md"],
    },
    builderWorktree: projectDir,
    builderSummary: "implemented",
    qaStrategy: "compact",
    state,
    maxCycles: 2,
    createQa: async (cwd, resumeId) => {
      created += 1;
      cws.push(cwd);
      resumeIds.push(resumeId);
      return new StaticAdapter(`qa-${created}`, {
        text: created === 1 ? 'STEP_STATUS: qa_fail | issues="retry"' : 'STEP_STATUS: qa_pass | summary="clean"',
        isError: false, numTurns: 1, costUsd: 0,
      });
    },
    fix: async () => ({ ok: true }),
    observeNativeCompactions: async (adapter) => { if (adapter.sessionId()) observedQaSessions.push(adapter.sessionId()!); },
  });
  assert.equal(result.outcome, "passed");
  assert.equal(created, 2);
  assert.notEqual(cws[0], cws[1]);
  assert.ok(cws.every((cwd) => cwd.includes("rafi-qa-") && cwd.endsWith("/review")));
  assert.deepEqual(resumeIds, [undefined, undefined]);
  assert.deepEqual(observedQaSessions, ["qa-1", "qa-2"]);
  assert.equal(state.sessionId, "qa-2");
});

test("current-workflow guard rejects branch identity drift before provider dispatch", async () => {
  const projectDir = temp("rafi-current-drift-");
  execFileSync("git", ["init", "-q"], { cwd: projectDir });
  execFileSync("git", ["config", "user.email", "guard@example.test"], { cwd: projectDir });
  execFileSync("git", ["config", "user.name", "Guard Test"], { cwd: projectDir });
  writeFileSync(join(projectDir, "file.txt"), "base\n");
  execFileSync("git", ["add", "file.txt"], { cwd: projectDir });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: projectDir });
  const before = captureCurrentWorkflowSessionIdentity(projectDir);
  const provider = new StaticAdapter("session-1", { text: "ok", isError: false, numTurns: 1, costUsd: 0 });
  const guarded = new CurrentWorkflowGuardAdapter(provider, projectDir);
  execFileSync("git", ["checkout", "-qb", "identity-drift"], { cwd: projectDir });
  assert.notEqual(captureCurrentWorkflowSessionIdentity(projectDir), before);
  await assert.rejects(guarded.sendTurn("must not dispatch"), /current-branch workflow paused/);
  assert.equal(provider.sends, 0);
  await guarded.close();
});

test("session loss withholds exact recovery without discarding preserved worktree state", () => {
  const projectDir = temp("rafi-recovery-preserves-worktree-");
  execFileSync("git", ["init", "-q"], { cwd: projectDir });
  execFileSync("git", ["config", "user.email", "recovery@example.test"], { cwd: projectDir });
  execFileSync("git", ["config", "user.name", "Recovery Test"], { cwd: projectDir });
  writeFileSync(join(projectDir, "base.txt"), "base\n");
  execFileSync("git", ["add", "base.txt"], { cwd: projectDir });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: projectDir });
  let run = createBuildRun({ repositoryRoot: projectDir, tickets: ["T001"], builder: SETTINGS });
  const ref = createProviderSessionRef({
    provider: "codex", sessionId: "lost-thread", role: "builder", stream: "builder",
    cwd: projectDir, configRoot: projectDir, workspaceIdentity: captureCurrentWorkflowSessionIdentity(projectDir), source: "observed",
  });
  run = persistBuildSession(projectDir, run, "builder", ref);
  run = releaseBuildLease(projectDir, run, "recoverable");
  writeFileSync(join(projectDir, "in-progress.txt"), "preserve me\n");
  const availability = {
    version: 1 as const, status: "unavailable" as const, checkedAt: new Date().toISOString(),
    reason: "not-found" as const, detail: "provider thread is gone", sessionRef: ref,
  };
  const projection = projectBuildRecovery(projectDir, run, new Date(), undefined, availability);
  assert.equal(projection.exactSessionId, undefined);
  assert.equal(projection.sessionCandidateRef?.sessionId, "lost-thread");
  assert.equal(projection.worktree, projectDir);
  assert.ok(projection.expectedChanges.includes("in-progress.txt"));
  assert.equal(buildRunSessionBinding(run, "qa"), undefined, "legacy QA mirrors are never exact candidates");
});

test("additive migration retains legacy raw sessions and is idempotent", () => {
  const projectDir = temp("rafi-session-migration-");
  const recoveryDir = join(projectDir, ".rafi");
  mkdirSync(recoveryDir);
  const path = join(recoveryDir, "recovery.sqlite3");
  const legacy = new Database(path);
  legacy.exec(`
    CREATE TABLE workflow_runs(run_id TEXT PRIMARY KEY,kind TEXT NOT NULL,status TEXT NOT NULL,checkpoint TEXT NOT NULL,original_work_json TEXT NOT NULL,remaining_work_json TEXT NOT NULL,state_json TEXT NOT NULL,lease_generation INTEGER,legacy INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE provider_sessions(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),role TEXT NOT NULL,stream TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,session_id TEXT,transition TEXT NOT NULL,settings_revision INTEGER NOT NULL,created_at TEXT NOT NULL);
    INSERT INTO workflow_runs VALUES('run-1','build','paused','legacy','{}','{}','{}',NULL,1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
    INSERT INTO provider_sessions(run_id,role,stream,provider,model,session_id,transition,settings_revision,created_at) VALUES('run-1','builder','builder','codex','default','legacy-id','checkpoint',0,'2026-01-01T00:00:00Z');
  `);
  legacy.close();

  new WorkflowDb(projectDir).close();
  new WorkflowDb(projectDir).close();
  const migrated = new Database(path, { readonly: true });
  const columns = (migrated.prepare("PRAGMA table_info(provider_sessions)").all() as Array<{ name: string }>).map((column) => column.name);
  assert.ok(columns.includes("session_key"));
  assert.ok(columns.includes("session_ref_json"));
  assert.ok(migrated.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='provider_session_bindings'").get());
  assert.deepEqual(migrated.prepare("SELECT session_id,session_key,session_ref_json FROM provider_sessions WHERE run_id='run-1'").get(), {
    session_id: "legacy-id", session_key: null, session_ref_json: null,
  });
  migrated.close();
});
